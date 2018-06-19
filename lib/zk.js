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
var mod_zkstream = require('zkstream');

function ZKCache(options) {
	mod_assert.object(options, 'options');
	mod_assert.object(options.log, 'options.log');
	mod_assert.object(options.pool, 'options.pool');
	mod_assert.arrayOfString(options.roots, 'options.roots');
	mod_assert.object(options.zkConfig, 'options.zkConfig');

	var conf = Object.create(options.zkConfig);
	conf.log = options.log;
	this.ca_zk = new mod_zkstream.Client(conf);
	this.ca_log = options.log.child({
		component: 'ZKCache'
	});
	this.ca_roots = options.roots;
	this.ca_pool = options.pool;
	this.ca_nodes = {};

	var self = this;
	this.ca_zk.on('session', function () {
		self.rebuildCache();
	});
}
ZKCache.prototype.rebuildCache = function () {
	var self = this;
	this.ca_roots.forEach(function (path) {
		var tn = self.ca_nodes[path];
		if (tn === undefined) {
			var parts = path.split('/');
			tn = new ZKNode(self,
			    parts.slice(0, parts.length - 1).join('/'),
			    parts[parts.length - 1]);
		}
		tn.rebind(self.ca_zk);
	});
};

function ZKNode(cache, dir, name) {
	this.zn_name = name;
	this.zn_dir = dir;
	this.zn_path = this.zn_dir + '/' + this.zn_name;

	this.zn_cache = cache;
	this.zn_kids = {};
	this.zn_data = null;
	this.zn_watcher = undefined;
	this.zn_log = cache.ca_log.child({
		component: 'ZKNode',
		path: this.zn_path
	});
	this.zn_log.trace('adding node to cache at "%s"', this.zn_path);
	this.zn_cache.ca_nodes[this.zn_path] = this;
}
ZKNode.prototype.rebind = function (zk) {
	var self = this;
	if (this.zn_watcher) {
		this.zn_watcher.removeAllListeners('childrenChanged');
		this.zn_watcher.removeAllListeners('dataChanged');
		this.zn_watcher = undefined;
	}
	this.zn_watcher = zk.watcher(this.zn_path);
	this.zn_watcher.on('childrenChanged',
	    this.onChildrenChanged.bind(this, zk));
	this.zn_watcher.on('dataChanged',
	    this.onDataChanged.bind(this, zk));
	Object.keys(this.zn_kids).forEach(function (k) {
		self.zn_kids[k].rebind(zk);
	});
};
ZKNode.prototype.unbind = function (_zk) {
	var self = this;
	if (this.zn_watcher) {
		this.zn_watcher.removeAllListeners('childrenChanged');
		this.zn_watcher.removeAllListeners('dataChanged');
		this.zn_watcher = undefined;
	}
	Object.keys(this.zn_kids).forEach(function (k) {
		self.zn_kids[k].unbind();
	});
	if (this.zn_cache.ca_nodes[this.zn_path] === this) {
		delete (this.zn_cache.ca_nodes[this.zn_path]);
		this.zn_cache.ca_pool.refreshTag(this.zn_path, []);
	}
};
ZKNode.prototype.onChildrenChanged = function (zk, kids, _stat) {
	var self = this;

	var newKids = {};
	kids.forEach(function (kid) {
		if (self.zn_kids[kid] !== undefined) {
			newKids[kid] = self.zn_kids[kid];
			delete (self.zn_kids[kid]);
		} else {
			newKids[kid] = new ZKNode(self.zn_cache,
			    self.zn_path, kid);
			newKids[kid].rebind(zk);
		}
	});
	Object.keys(this.zn_kids).forEach(function (oldKid) {
		self.zn_kids[oldKid].unbind();
	});
	this.zn_kids = newKids;
};
ZKNode.prototype.onDataChanged = function (_zk, data, _stat) {
	var parsedData;
	try {
		var str = data.toString('utf-8');
		parsedData = JSON.parse(str);
	} catch (e) {
		/* Ignore data in a node that we can't parse */
		this.zn_log.warn(e, 'ignoring node %s: failed to parse data',
		    this.zn_path);
		this.zn_cache.ca_pool.refreshTag(this.zn_path, []);
		return;
	}
	if (typeof (parsedData) !== 'object') {
		var er = new Error('Parsed JSON data is not an object');
		this.zn_log.warn(er, 'ignoring node %s: failed to parse data',
		    this.zn_path);
		this.zn_cache.ca_pool.refreshTag(this.zn_path, []);
		return;
	}
	this.zn_data = parsedData;

	if (parsedData === null || typeof (parsedData.type) !== 'string') {
		this.zn_cache.ca_pool.refreshTag(this.zn_path, []);
		return;
	}

	switch (parsedData.type) {
	case 'db_host':
	case 'host':
	case 'load_balancer':
	case 'moray_host':
	case 'redis_host':
	case 'ops_host':
	case 'rr_host':
		var record = parsedData[parsedData.type];
		if (typeof (record) !== 'object' || record === null) {
			this.zn_cache.ca_pool.refreshTag(this.zn_path, []);
			break;
		}
		var addr = record.address;
		this.zn_cache.ca_pool.refreshTag(this.zn_path, [addr]);
		break;

	default:
		this.zn_cache.ca_pool.refreshTag(this.zn_path, []);
		break;
	}
};

module.exports = {
	ZKCache: ZKCache
};
