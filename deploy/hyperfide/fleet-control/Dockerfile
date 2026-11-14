# Pin the OCI index so a rebuild cannot silently move to a different Node or
# Debian layer.  The digest covers the supported amd64/arm64 variants.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /app
COPY core/control-plane/package.json core/control-plane/package-lock.json core/control-plane/tsconfig.json ./core/control-plane/
COPY core/control-plane/scripts ./core/control-plane/scripts
COPY contracts/fleet ./contracts/fleet
COPY core/control-plane/src ./core/control-plane/src
COPY deploy/hyperfide/dist-stamp.mjs ./deploy/hyperfide/dist-stamp.mjs
RUN npm --prefix core/control-plane ci --ignore-scripts && npm --prefix core/control-plane run build && npm --prefix core/control-plane prune --omit=dev --ignore-scripts

# Pin the runtime index and every apt input.  Updates require an intentional
# digest/version change, preserving byte-for-byte rebuildability.
FROM ubuntu:24.04@sha256:2198e4c65076e9cb0b3d695219df667c0e3b0072da64ca3c2648aca17dcecaf5
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates=20260816ubuntu0.24.04.2 \
        libsqlite3-0=3.45.1-1ubuntu2.9 \
        libcurl4t64=8.5.0-2ubuntu10.16 \
        libssl3t64=3.0.13-0ubuntu3.16 \
        libstdc++6=14.2.0-4ubuntu2~24.04.1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /app/core/control-plane/package.json ./core/control-plane/package.json
COPY --from=build /app/core/control-plane/node_modules ./core/control-plane/node_modules
COPY --from=build /app/core/control-plane/dist ./core/control-plane/dist
COPY core/control-plane/components ./core/control-plane/components
COPY core/control-plane/migrations ./core/control-plane/migrations
COPY deploy/hyperfide/fleet-env.mjs ./deploy/hyperfide/fleet-env.mjs
COPY deploy/hyperfide/fleet-control ./deploy/hyperfide/fleet-control
COPY .fleet-runtime /opt/hyperfide/bin
RUN node deploy/hyperfide/fleet-control/prepare-image.mjs && node deploy/hyperfide/fleet-control/download-claude.mjs && mkdir -p /app/state && chown 22001:22001 /app/state && chmod 0700 /app/state
ENV PATH="/opt/hyperfide/bin:/usr/local/bin:/usr/bin:/bin"
USER 22001:22001
RUN node -e "if(process.getuid()!==22001||process.getgid()!==22001)process.exit(1);const fs=require('node:fs'),home=JSON.parse(fs.readFileSync('/opt/hyperfide/bin/manifest.json')).runtime_home;fs.realpathSync(home);fs.accessSync(home,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK)" && /opt/hyperfide/bin/hyperfide version && /opt/hyperfide/bin/hyperfide-native --component 13.1 --action connector.describe --request-base64 e30 && /opt/hyperfide/bin/claude --version
USER 0:0
CMD ["node", "deploy/hyperfide/fleet-control/volume-entrypoint.mjs"]
