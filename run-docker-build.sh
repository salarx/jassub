#! /bin/sh
set -e
cd "$(dirname "$0")"

usage() {
    echo "$0 [-f] [-c con_name] [-i img_name] [commmand [command_args...]]"
    echo "  -f: Skip building the container and reuse existing (\"fast\")"
    echo "  -c: Name of the container to create/use;"
    echo "      defaults to thaunknown_jassub-build"
    echo "  -i: Name of the image to buld/use;"
    echo "      defaults to thaunknown/jassub-build"
    echo "If no command is given `make` without arguments will be executed"
    echo
    echo "Environment:"
    echo "  CONTAINER_ENGINE  container runtime to use; defaults to docker."
    echo "                    Apple's 'container' (macOS 26+) works as a drop-in."
    echo "  CONTAINER_RUN_ARGS  extra args for the run step, e.g. --dns 1.1.1.1"
    exit 2
}

# Any OCI runtime with a docker-compatible build/run CLI works here. Apple's `container`
# is the native option on macOS 26+ and needs no VM of its own.
ENGINE="${CONTAINER_ENGINE:-docker}"

OPTIND=1
CONTAINER="thaunknown_jassub-build"
IMAGE="thaunknown/jassub-build"
FAST=0
while getopts "fc:s:" opt ; do
    case "$opt" in
        f) FAST=1 ;;
        c) CONTAINER="$OPTARG" ;;
        i) IMAGE="$OPTARG" ;;
        *) usage ;;
    esac
done

if [ "$OPTIND" -gt 1 ] ; then
    shift $(( OPTIND - 1 ))
fi

if [ "$FAST" -eq 0 ] ; then
    "$ENGINE" build -t "$IMAGE" .
fi
# Only ask for a TTY when there is one. Allocating one without a terminal fails outright - docker reports
# "the input device is not a TTY", Apple's container reports "Operation not supported by device" - which
# makes the build unusable from CI, a script, or anything running in the background.
if [ -t 0 ] ; then
    TTY_ARGS="-it"
else
    TTY_ARGS=""
fi

# TTY_ARGS and CONTAINER_RUN_ARGS are deliberately unquoted: they carry multiple words (e.g. --dns 1.1.1.1).
if [ "$#" -eq 0 ] ; then
    "$ENGINE" run $TTY_ARGS --rm -v "${PWD}":/code --name "$CONTAINER" $CONTAINER_RUN_ARGS "$IMAGE":latest
else
    "$ENGINE" run $TTY_ARGS --rm -v "${PWD}":/code --name "$CONTAINER" $CONTAINER_RUN_ARGS "$IMAGE":latest "$@"
fi
