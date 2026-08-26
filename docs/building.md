# How to build?

## Get the Source

Run git clone --recursive https://github.com/ThaUnknown/jassub.git

### In a container

1. Install a container runtime (see below)
2. `./run-docker-build.sh` or `./run-docker-build.ps1`

The shell script honours `CONTAINER_ENGINE` (default `docker`) and `CONTAINER_RUN_ARGS`, so any runtime with a
docker-compatible `build`/`run` CLI can drive the same image.

**Linux** — Docker or Podman natively.

**macOS 26+** — Apple's [`container`](https://github.com/apple/container) is a native alternative to Docker
Desktop:

```shell
brew install container && container system start
CONTAINER_ENGINE=container ./run-docker-build.sh
```

If DNS fails inside the container, your host resolver is probably on loopback (Cloudflare WARP sets
`127.0.2.2`), which the guest cannot reach. Point it at a reachable resolver:

```shell
CONTAINER_ENGINE=container CONTAINER_RUN_ARGS="--dns 1.1.1.1" ./run-docker-build.sh
```

**Windows** — there is no native Linux-container runtime. Docker Desktop, Podman Desktop and Rancher Desktop
all run the containers inside WSL2, and Windows containers can only run Windows images, so this Linux image
cannot run on them. The genuinely container-free path is to skip the container and build directly in WSL2:

```shell
wsl --install -d Ubuntu          # once, from PowerShell
```

then build inside WSL2 without any container — see *Without a container* below. `./run-docker-build.ps1`
still works if you would rather keep Docker Desktop.

### Without a container

Clone with `--recursive`: freetype has a nested submodule of its own (`subprojects/dlg`), and without it the
build stops at `check_out_submodule` trying to fetch it from inside the container, where the git metadata is
not reachable. `git submodule update --init --recursive` fixes an existing clone.

Four wasm variants are built. In the browser the loader picks between the first three by feature test; on a
server runtime there is no choice to make, because `@salarx/jassub/node` and `/deno` always load the fourth:

| target | flags | used by |
| --- | --- | --- |
| `make` | none | browsers without SIMD |
| `SIMD=1 make` | `-msimd128` and the SSE lowerings | browsers lacking relaxed SIMD, e.g. Safari |
| `MODERN=1 make` | the above plus `-mrelaxed-simd`, AVX, FMA | Chrome and other current browsers |
| `NODEJS=1 make` | the `SIMD=1` flags, linked `ENVIRONMENT=node` | Node, Bun and Deno |

The middle one exists because relaxed SIMD is not universal: JavaScriptCore rejects the modern binary
outright, and dropping straight to the scalar build costs about 3.3x on libass. `-mavx/-mavx2/-mfma` are
left out of it deliberately - emscripten implements those with relaxed instructions, which would put back
the very opcodes the variant exists to avoid.

The container exists only to pin the toolchain; the build itself is a plain `make`. On any Linux (including
WSL2) you need [emsdk](https://emscripten.org/docs/getting_started/downloads.html) 6.0.4 on `PATH` plus the
packages the [`Dockerfile`](../Dockerfile) installs:

```shell
sudo apt-get install -y build-essential cmake dos2unix git ragel patch libtool itstool \
    pkg-config python3 gettext autopoint automake autoconf m4 gperf licensecheck
npm install
make && SIMD=1 make && MODERN=1 make && NODEJS=1 make
```

All four invocations are needed: the package ships every variant, and the browser loader feature-tests
between the first three at runtime.
