/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var mod_assert = require('assert-plus');
var mod_verror = require('verror');
var mod_bunyan = require('bunyan');
var mod_fs = require('fs');
var mod_util = require('util');
var mod_path = require('path');
var mod_fsm = require('mooremachine');

var lib_ipf = require('./lib/ipf');
var Ipf = lib_ipf.Ipf;
var IpfPool = lib_ipf.IpfPool;
var IpMon = lib_ipf.IpMon;

var lib_zk = require('./lib/zk');
var ZKCache = lib_zk.ZKCache;

var VError = mod_verror.VError;

var confDir = mod_path.join(__dirname, 'etc');
var confFile = mod_path.join(confDir, 'config.json');
var ipfConfigFile = mod_path.join(confDir, 'ipf.conf');
var config = JSON.parse(mod_fs.readFileSync(confFile, 'utf-8'));

mod_assert.object(config, 'config');
mod_assert.object(config.zookeeper, 'config.zookeeper');
mod_assert.number(config.holdTime, 'config.holdTime');
mod_assert.optionalArrayOfString(config.paths, 'config.paths');
mod_assert.optionalArrayOfString(config.domains, 'config.domains');

if (config.paths === undefined)
	config.paths = [];
if (config.domains) {
	config.domains.forEach(function (domain) {
		var parts = domain.split('.').map(function (label) {
			return (label.toLowerCase());
		});
		parts.push('');
		parts.reverse();
		config.paths.push(parts.join('/'));
	});
}

var log = mod_bunyan.createLogger({
	name: 'waferlock',
	level: process.env.LOG_LEVEL || 'debug'
});

function AppFSM() {
	this.af_err = null;
	this.af_denials = {};
	this.af_log = log;
	mod_fsm.FSM.call(this, 'init');
}
mod_util.inherits(AppFSM, mod_fsm.FSM);

AppFSM.prototype.state_init = function (S) {
	var self = this;
	Ipf.flushAll(S.callback(function (err) {
		if (err && err.name === 'IpfDisabledError') {
			S.gotoState('enableIpf');
			return;
		}
		if (err) {
			self.af_err = new VError(
			    { cause: err, name: 'IpfFlushError' },
			    'failed to flush ipf rules');
			S.gotoState('fatal');
			return;
		}
		S.gotoState('setupPool');
	}));
};

AppFSM.prototype.state_enableIpf = function (S) {
	var self = this;
	Ipf.enable(S.callback(function (err) {
		if (err) {
			self.af_err = err;
			S.gotoState('fatal');
			return;
		}
		S.gotoState('setupPool');
	}));
};

AppFSM.prototype.state_setupPool = function (S) {
	var self = this;
	this.af_pool = new IpfPool({
		log: log,
		name: '100',
		holdTime: config.holdTime
	});
	this.af_pool.init(S.callback(function (err) {
		if (err) {
			self.af_err = err;
			S.gotoState('fatal');
			return;
		}
		S.gotoState('setupCache');
	}));
};

AppFSM.prototype.state_setupCache = function (S) {
	this.af_cache = new ZKCache({
		log: log,
		pool: this.af_pool,
		zkConfig: config.zookeeper,
		roots: config.paths
	});
	S.gotoState('waitInitialData');
};

AppFSM.prototype.state_waitInitialData = function (S) {
	var self = this;
	this.af_log.info('waiting for initial data set sync');

	var lastNodes = Object.keys(self.af_cache.ca_nodes).length;
	var roots = config.paths.length;
	S.interval(2000, function () {
		var nodes = Object.keys(self.af_cache.ca_nodes).length;
		if (nodes === lastNodes && nodes > roots) {
			/* Wait an extra sec just in case */
			S.timeout(1000, function () {
				S.gotoState('loadRules');
			});
		}
		lastNodes = nodes;
	});
};

AppFSM.prototype.state_loadRules = function (S) {
	var self = this;
	Ipf.loadRulesFile(ipfConfigFile, S.callback(function (err) {
		if (err) {
			self.af_err = err;
			S.gotoState('fatal');
			return;
		}
		S.gotoState('enforcing');
	}));
};

/* eslint-disable */
/* JSSTYLED */
var TUPLE_RE = / ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+),([0-9]+) -> ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+),([0-9]+) /;
/* eslint-enable */

AppFSM.prototype.state_enforcing = function (S) {
	var self = this;
	this.af_log.info('ipf rules loaded, now enforcing');
	this.af_mon = new IpMon({
		log: log
	});
	S.on(this.af_mon, 'line', function (line) {
		var m = TUPLE_RE.exec(line);
		if (!m) {
			self.af_log.trace({ ipmonLine: line }, 'unparseable ' +
			    'ipmon output line');
			return;
		}
		var fromIp = m[1];
		var fromPort = parseInt(m[2], 10);
		var toIp = m[3];
		var toPort = parseInt(m[4], 10);
		if (typeof (fromPort) !== 'number' || !isFinite(fromPort) ||
		    typeof (toPort) !== 'number' || !isFinite(toPort)) {
			return;
		}
		var ds = self.af_denials[fromIp];
		if (ds === undefined) {
			ds = (self.af_denials[fromIp] = {});
		}
		if (ds[toPort] === undefined) {
			self.af_log.debug({ fromIp: fromIp, fromPort: fromPort,
			    toIp: toIp, toPort: toPort },
			    'denied access from %s to port %d',
			    fromIp, toPort);
			ds[toPort] = 0;
		}
		ds[toPort]++;
	});
};

AppFSM.prototype.state_fatal = function (S) {
	S.validTransitions([]);
	log.error(this.af_err, 'fatal error');
	throw (this.af_err);
};

var app = new AppFSM();

function disableIpfAndExit() {
	if (app.af_mon && app.af_mon.isInState('running'))
		app.af_mon.stop();
	Ipf.disable(function () {
		process.exit(0);
	});
}
process.on('SIGINT', disableIpfAndExit);
process.on('SIGTERM', disableIpfAndExit);
