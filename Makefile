#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2018, Joyent, Inc.
#

NAME = waferlock

#
# Tools
#
TAPE :=			./node_modules/.bin/tape

#
# Makefile.defs defines variables used as part of the build process.
#
REQUIRE_ENG := $(shell git submodule update --init deps/eng)
include ./deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)

SAPI_MANIFESTS_IN =	sapi_manifests/$(NAME)/manifest.json.in
SAPI_MANIFESTS +=	$(SAPI_MANIFESTS_IN:%.in=%)
CLEAN_FILES +=		$(SAPI_MANIFESTS_IN:%.in=%)

#
# Configuration used by Makefile.defs and Makefile.targ to generate
# "check" and "docs" targets.
#
#DOC_FILES =		index.md boilerplateapi.md
JSON_FILES =		package.json $(SAPI_MANIFESTS)
JS_FILES :=		$(shell find lib -name '*.js') server.js
ESLINT_FILES =		$(JS_FILES)
JSSTYLE_FILES =		$(JS_FILES)

JSSTYLE_FLAGS =		-f tools/jsstyle.conf

PREFIX ?=		/opt/smartdc/$(NAME)

#
# Configuration used by Makefile.smf.defs to generate "check" and "all" targets
# for SMF manifest files.
#
SMF_MANIFESTS_IN =	smf/manifests/$(NAME).xml.in
include ./deps/eng/tools/mk/Makefile.smf.defs

#
# Historically, Node packages that make use of binary add-ons must ship their
# own Node built with the same compiler, compiler options, and Node version that
# the add-on was built with.  On SmartOS systems, we use prebuilt Node images
# via Makefile.node_prebuilt.defs.  On other systems, we build our own Node
# binary as part of the build process.  Other options are possible -- it depends
# on the need of your repository.
#
NODE_PREBUILT_VERSION =	v4.9.0
NODE_PREBUILT_IMAGE = 18b094b0-eb01-11e5-80c1-175dac7ddf02
ifeq ($(shell uname -s),SunOS)
	NODE_PREBUILT_TAG = gz
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.defs
else
	NODE := $(shell which node)
	NPM := $(shell which npm)
	NPM_EXEC=$(NPM)
endif

#
# Makefile.node_modules.defs provides a common target for installing modules
# with NPM from a dependency specification in a "package.json" file.  By
# including this Makefile, we can depend on $(STAMP_NODE_MODULES) to drive "npm
# install" correctly.
#
include ./deps/eng/tools/mk/Makefile.node_modules.defs


#
# MG Variables
#

RELEASE_TARBALL         := $(NAME)-pkg-$(STAMP).tar.bz2
ROOT                    := $(shell pwd)
RELSTAGEDIR             := /tmp/$(NAME)-$(STAMP)

#
# Repo-specific targets
#
.PHONY: all
all: $(SMF_MANIFESTS) $(STAMP_NODE_MODULES) $(SAPI_MANIFESTS) | $(REPO_DEPS)

#
# This example Makefile defines a special target for building manual pages.  You
# may want to make these dependencies part of "all" instead.
#
.PHONY: manpages
manpages: $(MAN_OUTPUTS)

.PHONY: test
test: $(STAMP_NODE_MODULES)
	$(NODE) $(TAPE) test/*.test.js

#
# MG targets
#
.PHONY: release
release: all
	@echo "Building $(RELEASE_TARBALL)"
	mkdir -p $(RELSTAGEDIR)/root/$(PREFIX)
	mkdir -p $(RELSTAGEDIR)/site
	touch $(RELSTAGEDIR)/site/.do-not-delete-me
	mkdir -p $(RELSTAGEDIR)/root
	mkdir -p $(RELSTAGEDIR)/root/$(PREFIX)/etc
	cp	$(ROOT)/etc/ipf.conf \
		$(RELSTAGEDIR)/root/$(PREFIX)/etc
	cp -r   $(ROOT)/lib \
		$(ROOT)/server.js \
		$(ROOT)/node_modules \
		$(ROOT)/package.json \
		$(ROOT)/smf \
		$(ROOT)/sapi_manifests \
		$(RELSTAGEDIR)/root/$(PREFIX)
	mkdir -p $(RELSTAGEDIR)/root/$(PREFIX)/build
	cp -r \
		$(ROOT)/build/node \
		$(RELSTAGEDIR)/root/$(PREFIX)/build
	(cd $(RELSTAGEDIR) && $(TAR) -jcf $(ROOT)/$(RELEASE_TARBALL) root site)
	rm -rf $(RELSTAGEDIR)


.PHONY: publish
publish: release
	@if [[ -z "$(BITS_DIR)" ]]; then \
		@echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/$(NAME)
	cp $(ROOT)/$(RELEASE_TARBALL) $(BITS_DIR)/$(NAME)/$(RELEASE_TARBALL)

#
# Target definitions.  This is where we include the target Makefiles for
# the "defs" Makefiles we included above.
#

include ./deps/eng/tools/mk/Makefile.deps

ifeq ($(shell uname -s),SunOS)
	include ./deps/eng/tools/mk/Makefile.node_prebuilt.targ
else
	include ./deps/eng/tools/mk/Makefile.node.targ
endif

include ./deps/eng/tools/mk/Makefile.smf.targ
include ./deps/eng/tools/mk/Makefile.node_modules.targ
include ./deps/eng/tools/mk/Makefile.targ

$(SAPI_MANIFESTS): %: %.in
	$(SED) \
	    -e 's#@@NODE@@#@@PREFIX@@/$(NODE_INSTALL)/bin/node#g' \
	    -e 's#@@PREFIX@@#$(PREFIX)#g' \
	    $< > $@
