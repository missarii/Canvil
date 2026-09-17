# Canvil sandbox image
#
# A small, reproducible image for `sandbox.mode = "docker"`.
# Build with:
#   docker build -t canvil-sandbox:latest docker/sandbox
# Then set CANVIL_SANDBOX_IMAGE=canvil-sandbox:latest
#
# The image is intentionally generic (node + python + go toolchains available)
# because Canvil must be able to run the target project's own test command. If
# your projects are all one stack, trim this down — a smaller image is a smaller
# supply-chain surface.

FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    CI=1 \
    NO_COLOR=1 \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ca-certificates \
        git \
        python3 \
        python3-pip \
        python3-venv \
        build-essential \
        curl \
    && rm -rf /var/lib/apt/lists/*

# `node` (uid 1000) is the default execution user; Canvil passes --user node.
USER node
WORKDIR /workspace

# No default CMD: Canvil always supplies the command to run.
CMD ["sh", "-lc", "echo 'canvil sandbox: no command supplied'"]
