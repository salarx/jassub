# JASSUB.js - Makefile

# make - Build Dependencies and the JASSUB.js
BASE_DIR:=$(dir $(realpath $(firstword $(MAKEFILE_LIST))))

# The MODERN build enables SIMD flags which affect all compiled artifacts.
# Keep caches separate so legacy and modern builds can coexist.
ifeq (${MODERN},1)
	BUILD_VARIANT := modern
else ifeq (${SIMD},1)
	BUILD_VARIANT := simd
else ifeq (${NODEJS},1)
	# deliberately the simd tree: same compiler flags, only the link differs
	BUILD_VARIANT := simd
else
	BUILD_VARIANT := legacy
endif

BUILD_LIB_DIR := $(BASE_DIR)build/lib/$(BUILD_VARIANT)
DIST_DIR := $(BASE_DIR)dist/libraries/$(BUILD_VARIANT)

export CFLAGS = -O3 -flto -fno-rtti -fno-exceptions -fno-math-errno -s USE_PTHREADS=1 -mnontrapping-fptoint -msign-ext -mbulk-memory -mreference-types -ffast-math -matomics
export CXXFLAGS = $(CFLAGS)
export PKG_CONFIG_PATH = $(DIST_DIR)/lib/pkgconfig
export EM_PKG_CONFIG_PATH = $(PKG_CONFIG_PATH)

SIMD_ARGS = \
	-msimd128 \
	-msse \
	-msse2 \
	-msse3 \
	-mssse3 \
	-msse4 \
	-msse4.1 \
	-msse4.2 \
	-mavx \
	-mavx2 \
	-ftree-vectorize \
	-mfma \
	-mrelaxed-simd

# Fixed-width SIMD only. The modern build is unusable anywhere relaxed SIMD is missing - Bun's
# JavaScriptCore rejects that binary outright ("relaxed simd instructions not supported"), so it falls all
# the way back to the scalar build and pays about 3x for it. simd128 itself is universal. The AVX/FMA
# lowerings are dropped along with -mrelaxed-simd because emscripten implements them with relaxed ops.
# Overridable per variant. The default pool expression is browser-specific: it asks the user agent and
# crossOriginIsolated, both of which are meaningless on a server runtime.
# emscripten picks the module format partly from the output extension. With ENVIRONMENT including node it
# emits require() alongside top-level await, and a .js file is then ambiguous to Node; .mjs is not.
WORKER_EXT ?= js
EXPORT_ES6 ?= 1
EXTRA_EXTERN_PRE ?=
ENVIRONMENT ?= worker
PTHREAD_POOL_SIZE ?= '!navigator.userAgent.toLowerCase().includes("firefox") && self.crossOriginIsolated ? Math.min(Math.max(0, navigator.hardwareConcurrency - 2), 8) : 0'

SIMD_ARGS_PLAIN = \
	-msimd128 \
	-msse \
	-msse2 \
	-msse3 \
	-mssse3 \
	-msse4 \
	-msse4.1 \
	-msse4.2 \
	-ftree-vectorize

ifeq (${MODERN},1)
	WORKER_NAME = jassub-worker-modern
	WORKER_ARGS = \
		-s WASM=1 \
		$(SIMD_ARGS)

	override CFLAGS += $(SIMD_ARGS)
	override CXXFLAGS += $(SIMD_ARGS)

else ifeq (${NODEJS},1)
	# Same libraries as the SIMD build, linked for a server runtime instead of a browser one.
	#
	# ENVIRONMENT=worker tells emscripten the only environment is a web Worker, so it never emits the Node
	# pthread path - the one that drives threads through worker_threads and does the handshake itself. Under
	# Bun that leaves the web-Worker path, which needs WorkerGlobalScope, a propagated name and a location
	# that Bun's workers do not have, and stalls even once all three are shimmed in.
	WORKER_NAME = jassub-worker-node
	WORKER_ARGS = \
		-s WASM=1 \
		$(SIMD_ARGS_PLAIN) \
		-s PTHREAD_POOL_SIZE_STRICT=0

	ENVIRONMENT = node,worker
	PTHREAD_POOL_SIZE = 8
	WORKER_EXT = mjs
	# gives emscripten's node path the CommonJS bindings it expects, without the file being CommonJS
	EXTRA_EXTERN_PRE = --extern-pre-js src/worker/extern-pre-node.js

	override CFLAGS += $(SIMD_ARGS_PLAIN)
	override CXXFLAGS += $(SIMD_ARGS_PLAIN)
else ifeq (${SIMD},1)
	WORKER_NAME = jassub-worker-simd
	WORKER_ARGS = \
		-s WASM=1 \
		$(SIMD_ARGS_PLAIN)

	override CFLAGS += $(SIMD_ARGS_PLAIN)
	override CXXFLAGS += $(SIMD_ARGS_PLAIN)
else
	WORKER_NAME = jassub-worker
	WORKER_ARGS = \
		-s WASM=1

endif

all: jassub
jassub: dist

.PHONY: all jassub dist

include functions.mk

# FriBidi
$(BUILD_LIB_DIR)/fribidi/configure: lib/fribidi $(wildcard $(BASE_DIR)build/patches/fribidi/*.patch)
	$(call PREPARE_SRC_PATCHED,fribidi)
	cd $(BUILD_LIB_DIR)/fribidi && $(RECONF_AUTO)

$(DIST_DIR)/lib/libfribidi.a: $(BUILD_LIB_DIR)/fribidi/configure
	cd $(BUILD_LIB_DIR)/fribidi && \
	$(call CONFIGURE_AUTO) --disable-debug --disable-deprecated && \
	$(JASSUB_MAKE) -C lib/ fribidi-unicode-version.h && \
	$(JASSUB_MAKE) -C lib/ install && \
	$(JASSUB_MAKE) install-pkgconfigDATA

# Brotli
$(BUILD_LIB_DIR)/brotli/configured: lib/brotli $(wildcard $(BASE_DIR)build/patches/brotli/*.patch)
	$(call PREPARE_SRC_PATCHED,brotli)
	touch $(BUILD_LIB_DIR)/brotli/configured

$(DIST_DIR)/lib/libbrotlidec.a: $(DIST_DIR)/lib/libbrotlicommon.a
$(DIST_DIR)/lib/libbrotlicommon.a: $(BUILD_LIB_DIR)/brotli/configured
	cd $(BUILD_LIB_DIR)/brotli && \
	$(call CONFIGURE_CMAKE) -DBROTLI_DISABLE_TESTS=ON && \
	$(JASSUB_MAKE) install
	# Normalise static lib names. Brotli >=1.1 installs libbrotli*.a directly, so the glob can match
	# nothing; skip missing entries instead of letting mv fail the build.
	cd $(DIST_DIR)/lib/ && \
	for lib in *-static.a ; do [ -e "$$lib" ] || continue ; mv "$$lib" "$${lib%-static.a}.a" ; done


# Freetype without Harfbuzz
$(BUILD_LIB_DIR)/freetype/configure: lib/freetype $(wildcard $(BASE_DIR)build/patches/freetype/*.patch)
	$(call PREPARE_SRC_PATCHED,freetype)
	cd $(BUILD_LIB_DIR)/freetype && $(RECONF_AUTO)

$(BUILD_LIB_DIR)/freetype/build_hb/dist_hb/lib/libfreetype.a: $(DIST_DIR)/lib/libbrotlidec.a $(BUILD_LIB_DIR)/freetype/configure
	cd $(BUILD_LIB_DIR)/freetype && \
		mkdir -p build_hb && \
		cd build_hb && \
		$(call CONFIGURE_AUTO,..) \
			--prefix="$$(pwd)/dist_hb" \
			--with-brotli=yes \
			--without-harfbuzz \
			--with-zlib=no \
			--with-png=no \
			--with-bzip2=no \
		&& \
		$(JASSUB_MAKE) install

# Harfbuzz
# hb.hh promotes ~40 warnings to hard errors via #pragma GCC diagnostic error. Newer clang (emsdk 6.0.4)
# emits some of them on harfbuzz's own code, which breaks the build outright. HB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR
# is harfbuzz's own documented escape hatch for this, and only affects warning severity, not codegen.
$(DIST_DIR)/lib/libharfbuzz.a: CFLAGS += -DHB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR
$(DIST_DIR)/lib/libharfbuzz.a: CXXFLAGS += -DHB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR
$(BUILD_LIB_DIR)/harfbuzz/configure: CFLAGS += -DHB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR
$(BUILD_LIB_DIR)/harfbuzz/configure: CXXFLAGS += -DHB_NO_PRAGMA_GCC_DIAGNOSTIC_ERROR

$(BUILD_LIB_DIR)/harfbuzz/configure: lib/harfbuzz $(wildcard $(BASE_DIR)build/patches/harfbuzz/*.patch)
	$(call PREPARE_SRC_PATCHED,harfbuzz)
	cd $(BUILD_LIB_DIR)/harfbuzz && $(RECONF_AUTO)

$(DIST_DIR)/lib/libharfbuzz.a: $(BUILD_LIB_DIR)/freetype/build_hb/dist_hb/lib/libfreetype.a $(BUILD_LIB_DIR)/harfbuzz/configure
	$(call PREPARE_SRC_PATCHED,harfbuzz)
	cd $(BUILD_LIB_DIR)/harfbuzz && $(RECONF_AUTO)
	cd $(BUILD_LIB_DIR)/harfbuzz && \
	EM_PKG_CONFIG_PATH=$(BUILD_LIB_DIR)/freetype/build_hb/dist_hb/lib/pkgconfig:$(PKG_CONFIG_PATH) \
	$(call CONFIGURE_AUTO) \
		--with-freetype \
		--with-glib=no \
		--with-cairo=no \
		--with-gobject=no \
		--with-icu=no \
		--with-graphite2=no \
	&& \
	cd src && \
	$(JASSUB_MAKE) install-libLTLIBRARIES install-pkgincludeHEADERS install-pkgconfigDATA

# Freetype with Harfbuzz
$(DIST_DIR)/lib/libfreetype.a: $(DIST_DIR)/lib/libharfbuzz.a $(DIST_DIR)/lib/libbrotlidec.a
	cd $(BUILD_LIB_DIR)/freetype && \
	EM_PKG_CONFIG_PATH=$(PKG_CONFIG_PATH):$(BUILD_LIB_DIR)/freetype/build_hb/dist_hb/lib/pkgconfig \
	$(call CONFIGURE_AUTO) \
		--with-brotli=yes \
		--with-harfbuzz \
		--with-zlib=no \
		--with-png=no \
		--with-bzip2=no \
	&& \
	$(JASSUB_MAKE) install

# libass
$(BUILD_LIB_DIR)/libass/configured: lib/libass
	cd lib/libass && $(RECONF_AUTO)
	$(call PREPARE_SRC_VPATH,libass)
	touch $(BUILD_LIB_DIR)/libass/configured

$(DIST_DIR)/lib/libass.a: $(DIST_DIR)/lib/libharfbuzz.a $(DIST_DIR)/lib/libfribidi.a $(DIST_DIR)/lib/libfreetype.a $(DIST_DIR)/lib/libbrotlidec.a $(BUILD_LIB_DIR)/libass/configured
	cd $(BUILD_LIB_DIR)/libass && \
	$(call CONFIGURE_AUTO,$(BASE_DIR)lib/libass) \
		--enable-large-tiles \
		--disable-fontconfig \
		--disable-require-system-font-provider \
		--enable-pthreads \
		--disable-asm \
	&& \
	$(JASSUB_MAKE) install

LIBASS_DEPS = \
	$(DIST_DIR)/lib/libfribidi.a \
	$(DIST_DIR)/lib/libbrotlicommon.a \
	$(DIST_DIR)/lib/libbrotlidec.a \
	$(DIST_DIR)/lib/libfreetype.a \
	$(DIST_DIR)/lib/libharfbuzz.a \
	$(DIST_DIR)/lib/libass.a


dist: $(LIBASS_DEPS) src/wasm/$(WORKER_NAME).$(WORKER_EXT)

# Dist Files https://github.com/emscripten-core/emscripten/blob/main/src/settings.js

# args for increasing performance
# https://github.com/emscripten-core/emscripten/issues/13899
PERFORMANCE_ARGS = \
		-s BINARYEN_EXTRA_PASSES=--one-caller-inline-max-function-size=19306 \
		-s INVOKE_RUN=0 \
		-s DISABLE_EXCEPTION_CATCHING=1 \
		-s TEXTDECODER=2 \
		-s INITIAL_MEMORY=32MB \
		-s MALLOC=mimalloc \
		-s WASM_BIGINT=1 \
		-s DYNAMIC_EXECUTION=0 \
		-s EMBIND_AOT=1 \
		-s MINIMAL_RUNTIME_STREAMING_WASM_INSTANTIATION=1 \
		-flto \
		-fno-exceptions \
		-fno-math-errno \
		-mnontrapping-fptoint \
		-msign-ext \
		-mreference-types \
		-s STACK_SIZE=256KB \
		-ffast-math \
		-matomics \
		-O3

# args for reducing size
SIZE_ARGS = \
		-s POLYFILL=0 \
		-s FILESYSTEM=0 \
		-s AUTO_JS_LIBRARIES=0 \
		-s AUTO_NATIVE_LIBRARIES=0 \
		-s HTML5_SUPPORT_DEFERRING_USER_SENSITIVE_REQUESTS=0 \
		-s INCOMING_MODULE_JS_API="[]" \
		-s USE_SDL=0 \
		-s EXPORTED_RUNTIME_METHODS="[]" \
		-s MINIMAL_RUNTIME=1 

# args that are required for this to even work at all
COMPAT_ARGS = \
		-s EXPORTED_FUNCTIONS="['_malloc']" \
		-s EXPORT_KEEPALIVE=1 \
		-s DISABLE_EXCEPTION_THROWING=1 \
		-s DEFAULT_LIBRARY_FUNCS_TO_INCLUDE='["$$stringToNewUTF8"]' \
		-mbulk-memory

# LIBASS_DEPS belongs here: without it, rebuilding any static library (a submodule bump, a patch change)
# leaves the previously linked wasm in place and make reports success, so the output silently does not
# contain the libraries that were just built.
src/wasm/$(WORKER_NAME).$(WORKER_EXT): src/JASSUB.cpp src/worker/pre-worker.js src/worker/extern-pre-worker.js $(LIBASS_DEPS)
	mkdir -p src/wasm
	emcc src/JASSUB.cpp $(LIBASS_DEPS) \
		$(WORKER_ARGS) \
		$(PERFORMANCE_ARGS) \
		$(SIZE_ARGS) \
		$(COMPAT_ARGS) \
		$(EXTRA_EXTERN_PRE) \
		--extern-pre-js src/worker/extern-pre-worker.js \
		--pre-js src/worker/pre-worker.js \
		--emit-tsd='types.d.ts' \
		-s ENVIRONMENT=$(ENVIRONMENT) \
		-s EXIT_RUNTIME=0 \
		-s ALLOW_MEMORY_GROWTH=1 \
		-s GROWABLE_ARRAYBUFFERS=0 \
		-s MODULARIZE=1 \
		-s EXPORT_ES6=$(EXPORT_ES6) \
		-lembind \
		-pthread \
		-s PTHREAD_POOL_SIZE=$(PTHREAD_POOL_SIZE) \
		-o $@

# dist/license/all:
#	@#FIXME: allow -j in toplevel Makefile and reintegrate licence extraction into this file
#	make -j "$$(nproc)" -f Makefile_licence all

# dist/js/COPYRIGHT: dist/license/all
#	cp "$<" "$@"

# Clean Tasks

clean: clean-dist clean-libs clean-jassub

clean-dist:
	rm -frv dist/libraries/*
	rm -frv src/wasm/*
	rm -frv dist/license/*
clean-libs:
	rm -frv dist/libraries build/lib
clean-jassub:
	cd src && git clean -fdX

git-checkout:
	git submodule sync --recursive && \
	git submodule update --init --recursive

SUBMODULES := brotli freetype fribidi harfbuzz libass
git-smreset: $(addprefix git-, $(SUBMODULES))

$(foreach subm, $(SUBMODULES), $(eval $(call TR_GIT_SM_RESET,$(subm))))

server: # Node http server npm i -g http-server
	http-server

.PHONY: clean clean-dist clean-libs clean-jassub git-checkout git-smreset server
