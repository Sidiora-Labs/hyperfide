FROM node:24.22.0-bookworm-slim AS build
WORKDIR /app
COPY core/control-plane/package.json core/control-plane/package-lock.json core/control-plane/tsconfig.json ./core/control-plane/
COPY core/control-plane/scripts ./core/control-plane/scripts
COPY contracts/fleet ./contracts/fleet
COPY core/control-plane/src ./core/control-plane/src
COPY deploy/hyperfide/dist-stamp.mjs ./deploy/hyperfide/dist-stamp.mjs
RUN npm --prefix core/control-plane ci --ignore-scripts && npm --prefix core/control-plane run build && npm --prefix core/control-plane prune --omit=dev --ignore-scripts

FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libsqlite3-0 libcurl4t64 libssl3t64 libstdc++6 && rm -rf /var/lib/apt/lists/*
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
RUN node -e "if(process.getuid()!==22001||process.getgid()!==22001)process.exit(1)" && /opt/hyperfide/bin/hyperfide version && /opt/hyperfide/bin/hyperfide-native --component 13.1 --action connector.describe --request-base64 e30 && /opt/hyperfide/bin/claude --version
CMD ["node", "deploy/hyperfide/fleet-control/volume-entrypoint.mjs"]
