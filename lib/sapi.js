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
var mod_verror = require('verror');
var mod_fsm = require('mooremachine');
var mod_util = require('util');
var mod_restify = require('restify-clients');
var mod_qs = require('querystring');

var VError = mod_verror.VError;

function SapiPoller(options) {
	mod_assert.object(options.log, 'options.log');
	mod_assert.object(options.pool, 'options.pool');
	mod_assert.object(options.agent, 'options.agent');

	mod_assert.string(options.url, 'options.url');
	mod_assert.string(options.service, 'options.service');
	mod_assert.string(options.dns_domain, 'options.dns_domain');

	mod_assert.number(options.minPoll, 'options.minPoll');
	mod_assert.number(options.maxPoll, 'options.maxPoll');

	this.sp_log = options.log.child({
		component: 'SapiPoller',
		service: options.service
	});
	this.sp_pool = options.pool;
	this.sp_url = options.url;
	this.sp_suffix = options.dns_domain;

	var parts = options.service.split('/');
	mod_assert.equal(parts.length, 2);
	this.sp_app = parts[0];
	this.sp_svc = parts[1];
	this.sp_app_uuid = undefined;
	this.sp_svc_uuid = undefined;

	this.sp_dc = undefined;
	this.sp_vmq = [];

	this.sp_minp = options.minPoll;
	this.sp_maxp = options.maxPoll;
	this.sp_lastp = new Date();
	this.sp_lastp.setTime(0);

	this.sp_errdelay = options.minPoll;

	this.sp_insts = {};
	this.sp_lastError = undefined;

	this.sp_agent = options.agent;

	this.sp_sapi = new mod_restify.createJsonClient({
		url: this.sp_url,
		agent: this.sp_agent,
		requestTimeout: 10000,
		retry: false
	});
	this.sp_vmapis = {};

	mod_fsm.FSM.call(this, 'app');
}
mod_util.inherits(SapiPoller, mod_fsm.FSM);

SapiPoller.prototype.state_app = function (S) {
	var self = this;
	var opts = { name: this.sp_app };
	if (this.sp_app !== 'sdc')
		opts.include_master = '1';
	var qs = mod_qs.stringify(opts);
	this.sp_sapi.get('/applications?' + qs, S.callback(
	    function (err, req, res, objs) {
		if (err) {
			self.sp_lastError = new VError(err, 'failed to fetch ' +
			    'app data from SAPI');
			S.gotoState('error');
			return;
		}

		mod_assert.arrayOfObject(objs);
		if (objs.length !== 1) {
			self.sp_lastError = new VError('ambiguous SAPI app ' +
			    'name: "%s"', self.sp_app);
			S.gotoState('error');
			return;
		}

		self.sp_app_uuid = objs[0].uuid;
		if (self.sp_app === 'sdc')
			self.sp_dc = objs[0].metadata['datacenter_name'];
		S.gotoState('svc');
	}));
};

SapiPoller.prototype.state_svc = function (S) {
	var self = this;
	var opts = {
		name: this.sp_svc,
		application_uuid: this.sp_app_uuid
	};
	if (this.sp_app !== 'sdc')
		opts.include_master = '1';
	var qs = mod_qs.stringify(opts);
	this.sp_sapi.get('/services?' + qs, S.callback(
	    function (err, req, res, objs) {
		if (err) {
			self.sp_lastError = new VError(err, 'failed to fetch ' +
			    'service data from SAPI');
			S.gotoState('error');
			return;
		}

		mod_assert.arrayOfObject(objs);
		if (objs.length !== 1) {
			self.sp_lastError = new VError('ambiguous SAPI svc ' +
			    'name: "%s"', self.sp_svc);
			S.gotoState('error');
			return;
		}

		self.sp_svc_uuid = objs[0].uuid;
		S.gotoState('insts');
	}));
};

SapiPoller.prototype.state_insts = function (S) {
	var self = this;
	var opts = {
		service_uuid: this.sp_svc_uuid
	};
	if (this.sp_app !== 'sdc')
		opts.include_master = '1';
	var qs = mod_qs.stringify(opts);
	this.sp_sapi.get('/instances?' + qs, S.callback(
	    function (err, req, res, objs) {
		if (err) {
			self.sp_lastError = new VError(err, 'failed to fetch ' +
			    'instance list from SAPI');
			S.gotoState('error');
			return;
		}

		mod_assert.arrayOfObject(objs);
		var oldids = self.sp_insts;
		var newids = {};
		objs.forEach(function (i) {
			newids[i.uuid] = i;
		});

		var added = Object.keys(newids).filter(function (id) {
			return (oldids[id] === undefined);
		});
		var removed = Object.keys(oldids).filter(function (id) {
			return (newids[id] === undefined);
		});

		self.sp_insts = newids;
		if (added.length > 0 || removed.length > 0) {
			self.sp_log.debug('detected %d added, %d removed',
			    added.length, removed.length);
		}

		removed.forEach(function (id) {
			self.sp_pool.refreshTag('sapi:' + id, []);
		});

		var bydc = {};
		added.forEach(function (id) {
			var inst = newids[id];
			var dc = inst.metadata['DATACENTER'];
			if (dc === undefined)
				dc = self.sp_dc;
			if (dc === undefined) {
				self.sp_log.warn('dropping sapi inst %s: ' +
				    'cannot determine dc', id);
				return;
			}
			if (bydc[dc] === undefined)
				bydc[dc] = [];
			bydc[dc].push(id);
		});

		Object.keys(bydc).forEach(function (dc) {
			var vms = bydc[dc];
			for (var i = 0; i < vms.length; i += 50) {
				self.sp_vmq.push({
					dc: dc,
					vms: vms.slice(i, i + 50)
				});
			}
		});

		S.gotoState('runq');
	}));
};

SapiPoller.prototype.state_runq = function (S) {
	this.sp_ent = this.sp_vmq.shift();
	if (this.sp_ent === undefined) {
		this.sp_lastp = new Date();
		S.gotoState('sleep');
		return;
	}
	S.gotoState('runq_do');
};

SapiPoller.prototype.state_runq_do = function (S) {
	var ent = this.sp_ent;
	var self = this;
	var vmapi = this.sp_vmapis[ent.dc];
	if (vmapi === undefined) {
		vmapi = new mod_restify.createJsonClient({
			url: 'http://vmapi.' + ent.dc + '.' + this.sp_suffix,
			agent: this.sp_agent
		});
		this.sp_vmapis[ent.dc] = vmapi;
	}

	var pred = { 'or': [] };
	ent.vms.forEach(function (uuid) {
		pred.or.push({ eq: ['uuid', uuid] });
	});
	if (pred.or.length === 1)
		pred = pred.or[0];

	var qs = mod_qs.stringify({
		predicate: JSON.stringify(pred)
	});
	vmapi.get('/vms?' + qs, S.callback(function (err, req, res, objs) {
		if (err) {
			self.sp_vmq.push(ent);
			self.sp_lastError = new VError(err, 'failed to fetch ' +
			    'VM data from %s VMAPI', ent.dc);
			S.gotoState('error');
			return;
		}

		mod_assert.arrayOfObject(objs);

		objs.forEach(function (vm) {
			if (vm.state === 'destroyed' || vm.destroyed)
				return;
			if (vm.state === 'failed')
				return;
			if (!vm.nics || !Array.isArray(vm.nics))
				return;

			var ips = [];
			vm.nics.forEach(function (nic) {
				if (typeof (nic) !== 'object')
					return;
				var ipa = nic.ips;
				if (ipa === undefined)
					ipa = [nic.ip];
				ipa.forEach(function (ip) {
					var parts = ip.split('/');
					ips.push(parts[0]);
				});
			});

			self.sp_pool.refreshTag('sapi:' + vm.uuid, ips);
		});

		S.gotoState('runq');
	}));
};

SapiPoller.prototype.state_sleep = function (S) {
	var now = (new Date()).getTime();
	var last = this.sp_lastp.getTime();
	var nextMin = last + this.sp_minp * 1000;
	var nextMax = last + this.sp_maxp * 1000;

	var maxDelay = nextMax - now;
	S.timeout(maxDelay, function () {
		S.gotoState('insts');
	});

	S.on(this, 'trigger', function () {
		var newNow = (new Date()).getTime();
		if (newNow > nextMin) {
			S.gotoState('insts');
		} else {
			var minDelay = nextMin - newNow;
			S.timeout(minDelay, function () {
				S.gotoState('insts');
			});
		}
	});

	this.sp_errdelay = this.sp_minp;
};

SapiPoller.prototype.trigger = function () {
	this.emit('trigger');
};

SapiPoller.prototype.state_error = function (S) {
	var self = this;

	var delay = this.sp_errdelay;
	var newDelay = delay * 2;
	if (newDelay > this.sp_maxp)
		newDelay = this.sp_maxp;
	this.sp_errdelay = newDelay;

	this.sp_log.error(this.sp_lastError, 'error during poll, retry ' +
	    'after %d sec', delay);
	S.timeout(delay * 1000, function () {
		if (!self.sp_app_uuid) {
			S.gotoState('app');
			return;
		}
		if (!self.sp_svc_uuid) {
			S.gotoState('svc');
			return;
		}
		S.gotoState('insts');
	});
};

module.exports = {
	SapiPoller: SapiPoller
};
