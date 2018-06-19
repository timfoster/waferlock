/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

'use strict';

var mod_assert = require('assert-plus');
var mod_vasync = require('vasync');
var mod_verror = require('verror');
var mod_forkexec = require('forkexec');
var mod_util = require('util');
var mod_ipaddr = require('ipaddr.js');
var mod_cproc = require('child_process');
var mod_lstream = require('lstream');
var mod_fsm = require('mooremachine');

var VError = mod_verror.VError;

var Ipf = {};
Ipf.flushAll = function (cb) {
	mod_forkexec.forkExecWait({
		argv: ['pfexec', 'ipf', '-F', 'a']
	}, function (err, info) {
		if (info.status === 1 &&
		    info.stderr.indexOf('I/O error') !== -1) {
			err = new VError({ cause: err,
			    name: 'IpfDisabledError' }, 'ipf is disabled');
			cb(err);
			return;
		}
		if (info.status !== 0) {
			cb(err);
			return;
		}
		cb();
	});
};
Ipf.enable = function (cb) {
	mod_forkexec.forkExecWait({
		argv: ['pfexec', 'ipf', '-E']
	}, cb);
};
Ipf.disable = function (cb) {
	mod_forkexec.forkExecWait({
		argv: ['pfexec', 'ipf', '-D']
	}, cb);
};
Ipf.loadRulesFile = function (path, cb) {
	mod_forkexec.forkExecWait({
		argv: ['pfexec', 'ipf', '-I', '-f', path, '-s']
	}, cb);
};

function IpMon(options) {
	mod_assert.object(options, 'options');
	mod_assert.object(options.log, 'options.log');

	this.im_kid = undefined;
	this.im_log = options.log.child({
		component: 'IpMon'
	});
	this.im_outls = new mod_lstream();
	this.im_errls = new mod_lstream();

	mod_fsm.FSM.call(this, 'spawning');
}
mod_util.inherits(IpMon, mod_fsm.FSM);

IpMon.prototype.state_spawning = function (S) {
	var self = this;

	var opts = {};
	opts.env = {};
	try {
		this.im_kid = mod_cproc.spawn('pfexec', ['ipmon', '-p'], opts);
	} catch (e) {
		this.im_lastError = new VError(e,
		    'failed to spawn ipmon command');
		S.gotoState('error');
		return;
	}

	S.on(this.im_kid, 'error', function (err) {
		self.im_lastError = new VError(err, 'ipmon command failed');
		self.gotoState('error');
	});

	this.im_kid.stderr.pipe(this.im_errls);
	this.im_kid.stdout.pipe(this.im_outls);

	S.on(this.im_errls, 'line', function (line) {
		self.im_lastError = new VError(new Error(line), 'ipmon ' +
		    'command error');
		S.gotoState('error');
	});

	S.on(this.im_outls, 'line', function () {
		S.gotoState('running');
	});

	S.on(this.im_kid, 'close', function (code) {
		self.im_lastError = new VError('ipmon command exited ' +
		    'unexpectedly with error code %d', code);
		S.gotoState('error');
	});
};

IpMon.prototype.state_running = function (S) {
	var self = this;

	S.on(this.im_kid, 'error', function (err) {
		self.im_lastError = new VError(err, 'ipmon command failed');
		self.gotoState('error');
	});

	S.on(this.im_errls, 'line', function (line) {
		self.im_lastError = new VError(new Error(line), 'ipmon ' +
		    'command error');
		S.gotoState('error');
	});

	S.on(this.im_outls, 'readable', function () {
		var line;
		while ((line = self.im_outls.read()) !== null) {
			self.emit('line', line);
		}
	});

	S.on(this.im_kid, 'close', function (code) {
		if (code !== 0) {
			self.im_lastError = new VError('ipmon command exited ' +
			    'unexpectedly with error code %d', code);
			S.gotoState('error');
		} else {
			S.gotoState('stopped');
		}
	});

	S.on(this, 'stopAsserted', function () {
		S.gotoState('stopping');
	});
};

IpMon.prototype.state_stopping = function (S) {
	S.on(this.im_kid, 'error', function (_err) {
	});
	S.on(this.im_kid, 'close', function (_code) {
		S.gotoState('stopped');
	});
	this.im_kid.kill();
};

IpMon.prototype.stop = function () {
	mod_assert.ok(this.isInState('running'));
	this.emit('stopAsserted');
};

IpMon.prototype.state_stopped = function (S) {
	S.validTransitions([]);
};

IpMon.prototype.state_error = function (S) {
	S.validTransitions([]);
	this.emit('error', this.im_lastError);
	this.im_kid.kill();
};

function IpfPool(options) {
	mod_assert.object(options, 'options');
	mod_assert.object(options.log, 'options.log');
	mod_assert.string(options.name, 'options.name');
	mod_assert.number(options.holdTime, 'options.holdTime');

	this.ipp_log = options.log.child({
		component: 'IpfPool',
		pool: options.name
	});
	this.ipp_name = options.name;
	this.ipp_hold = options.holdTime * 1000;
	this.ipp_addrs = {};
	this.ipp_tags = {};
	this.ipp_timers = {};
}
IpfPool.prototype.init = function (cb) {
	var self = this;
	this.ipp_log.info('setting up ipf pool');
	IpfPool.create(this.ipp_name, 'tree', function (err) {
		if (err && err.name === 'PoolExistsError') {
			IpfPool.destroy(self.ipp_name, 'tree', function (err2) {
				if (err2) {
					cb(err2);
					return;
				}
				IpfPool.create(self.ipp_name, 'tree', cb);
			});
			return;
		}
		cb(err);
	});
};
IpfPool.prototype.expire = function (key) {
	var self = this;
	delete (this.ipp_timers[key]);
	IpfPool.removeMask(this.ipp_name, key, function (err) {
		if (err) {
			self.ipp_log.error(err, 'failed to remove expiring ip');
			return;
		}
		self.ipp_log.debug('expired address %s', key);
	});
};
IpfPool.prototype.refreshTag = function (tag, addrs, cb) {
	var self = this;

	var keys = addrs.map(function (addr) {
		var ipaddr = mod_ipaddr.parse(addr);
		return (ipaddr.toNormalizedString());
	});

	var oldKeys = this.ipp_tags[tag];
	if (oldKeys === undefined)
		oldKeys = [];
	this.ipp_tags[tag] = keys;

	var added = keys.filter(function (k) {
		return (oldKeys.indexOf(k) === -1);
	});
	var removed = oldKeys.filter(function (k) {
		return (keys.indexOf(k) === -1);
	});

	var held = [];
	removed.forEach(function (k) {
		var tags = self.ipp_addrs[k];
		mod_assert.arrayOfString(tags);
		mod_assert.ok(tags.length > 0);
		var idx = tags.indexOf(tag);
		mod_assert.notStrictEqual(idx, -1);
		tags.splice(idx, 1);
		if (tags.length === 0) {
			delete (self.ipp_addrs[k]);
			held.push(k);
		}
	});

	if (held.length > 0) {
		var now = (new Date()).getTime();
		var expiry = Math.ceil((now + this.ipp_hold) / 5000) * 5000;
		var timeout = expiry - now;

		held.forEach(function (k) {
			mod_assert.strictEqual(self.ipp_timers[k], undefined);
			self.ipp_timers[k] = setTimeout(
			    self.expire.bind(self, k), timeout);
		});

		self.ipp_log.debug({ addrs: held, tag: tag }, 'holding %d ' +
		    'addresses for %d ms', held.length, timeout);
	}

	var news = [];
	added.forEach(function (k) {
		var timer = self.ipp_timers[k];
		if (timer !== undefined) {
			clearTimeout(timer);
			delete (self.ipp_timers[k]);
			mod_assert.strictEqual(self.ipp_addrs[k], undefined);
			self.ipp_addrs[k] = [tag];
			return;
		}
		var tags = self.ipp_addrs[k];
		if (tags === undefined) {
			tags = (self.ipp_addrs[k] = []);
			news.push(k);
		}
		tags.push(tag);
	});

	if (news.length > 0) {
		self.ipp_log.debug({ addrs: news, tag: tag },
		    'adding new addresses');
		mod_vasync.forEachPipeline({
			inputs: news,
			func: function (k, ccb) {
				IpfPool.addMask(self.ipp_name, k, ccb);
			}
		}, function (err, res) {
			if (cb)
				cb(err);
		});
	} else if (cb) {
		setImmediate(cb);
	}
};

IpfPool.create = function (name, type, cb) {
	mod_forkexec.forkExecWait({
		argv: [
			'pfexec', 'ippool', '-A', '-o', 'ipf', '-t', type,
			'-m', name
		]
	}, function (err, info) {
		if (info.status === 255 &&
		    info.stderr.indexOf(': File exists') !== -1) {
			err = new VError({ cause: err,
			    name: 'PoolExistsError' },
			    'pool "%s" already exists', name);
			cb(err);
			return;
		}
		if (info.status !== 0) {
			cb(err);
			return;
		}
		cb();
	});
};
IpfPool.destroy = function (name, type, cb) {
	mod_forkexec.forkExecWait({
		argv: [
			'pfexec', 'ippool', '-R', '-o', 'ipf', '-t', type,
			'-m', name
		]
	}, cb);
};
IpfPool.addMask = function (name, addr, cb) {
	mod_forkexec.forkExecWait({
		argv: ['pfexec', 'ippool', '-a', '-m', name, '-i', addr]
	}, cb);
};
IpfPool.removeMask = function (name, addr, cb) {
	mod_forkexec.forkExecWait({
		argv: ['pfexec', 'ippool', '-r', '-m', name, '-i', addr]
	}, cb);
};

module.exports = {
	Ipf: Ipf,
	IpfPool: IpfPool,
	IpMon: IpMon
};
