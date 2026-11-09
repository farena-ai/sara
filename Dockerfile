# Sara's container image (docker-compose.yml builds it; scripts/release-docker.sh builds the
# published multi-arch image for linux/amd64 + linux/arm64 at ghcr.io/farena-ai/sara).
#
# NODE_VERSION is the same pinned Node.js release as deploy/install.sh (test/packaging.test.ts
# checks they match), so a container and a native install run the same runtime. NODE_DIGEST pins
# that tag's multi-arch index (one digest for every platform; each platform pulls its own image
# from it), so a rebuilt tag upstream can't change what we ship. Change both together; the
# digest comes from: docker buildx imagetools inspect node:<version>-slim (the top "Digest:" line).
# Multi-arch safe: Node comes from the base image and Sara has no native npm packages, so nothing
# below downloads anything for one architecture only.
ARG NODE_VERSION=24.22.1
ARG NODE_DIGEST=sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
FROM node:${NODE_VERSION}-slim@${NODE_DIGEST}

ARG SARA_VERSION=dev
LABEL org.opencontainers.image.title="Sara" \
      org.opencontainers.image.description="A self-hosted AI companion and coding partner." \
      org.opencontainers.image.source="https://github.com/farena-ai/sara" \
      org.opencontainers.image.url="https://sara.backstagecoding.com" \
      org.opencontainers.image.documentation="https://github.com/farena-ai/sara/blob/main/docs/INSTALL.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Frank Arena and Backstage Coding" \
      org.opencontainers.image.version="${SARA_VERSION}"

# git and curl for her coding tools; openssh-client for your other servers over SSH (Phase 73);
# certificates for HTTPS; tini reaps the processes her tools
# leave behind and passes stop signals on.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl openssh-client ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --no-create-home --shell /usr/sbin/nologin sara-tools

WORKDIR /app
ENV NODE_ENV=production \
    SARA_DATA=/data \
    SARA_HOST=0.0.0.0 \
    SARA_PORT=7860 \
    SARA_TOOLS_USER=sara-tools

COPY package.json package-lock.json ./
COPY LICENSE ./LICENSE
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY src ./src
COPY web ./web
COPY persona ./persona
COPY templates ./templates
COPY skills ./skills
# Phase 117: the plugins that come with Sara (Signal); installed only through their review card.
COPY plugins ./plugins
# Local workflow candidates remain untrusted packages; no catalog authoring data ships here.
COPY store/plugins/daily-briefing ./store/plugins/daily-briefing
COPY store/plugins/meeting-assistant ./store/plugins/meeting-assistant
COPY store/plugins/document-desk ./store/plugins/document-desk
COPY store/plugins/research-notebook ./store/plugins/research-notebook
COPY store/plugins/project-handoff ./store/plugins/project-handoff
COPY store/plugins/weekly-review ./store/plugins/weekly-review
COPY store/plugins/inbox-triage ./store/plugins/inbox-triage
COPY store/plugins/content-studio ./store/plugins/content-studio
COPY store/plugins/image-workshop ./store/plugins/image-workshop
COPY store/plugins/spreadsheet-assistant ./store/plugins/spreadsheet-assistant
COPY store/plugins/travel-planner ./store/plugins/travel-planner
COPY store/plugins/home-dashboard ./store/plugins/home-dashboard
COPY store/plugins/secret-scanner ./store/plugins/secret-scanner
COPY store/plugins/license-auditor ./store/plugins/license-auditor
COPY store/plugins/sbom-builder ./store/plugins/sbom-builder
COPY store/plugins/artifact-provenance-verifier ./store/plugins/artifact-provenance-verifier
COPY store/plugins/coverage-explorer ./store/plugins/coverage-explorer
COPY store/plugins/log-explorer ./store/plugins/log-explorer
COPY store/plugins/incident-workbench ./store/plugins/incident-workbench
COPY store/plugins/environment-config-doctor ./store/plugins/environment-config-doctor
COPY store/plugins/database-fixture-studio ./store/plugins/database-fixture-studio
COPY store/plugins/data-contract-validator ./store/plugins/data-contract-validator
COPY store/plugins/change-impact-analyzer ./store/plugins/change-impact-analyzer
COPY store/plugins/architecture-guard ./store/plugins/architecture-guard
COPY store/plugins/sql-migration-reviewer ./store/plugins/sql-migration-reviewer
COPY store/plugins/visual-regression ./store/plugins/visual-regression
COPY store/plugins/localization-qa ./store/plugins/localization-qa
COPY store/plugins/accessibility-auditor ./store/plugins/accessibility-auditor
COPY store/plugins/build-cache-inspector ./store/plugins/build-cache-inspector
COPY store/plugins/api-contract-guard ./store/plugins/api-contract-guard
COPY store/plugins/http-webhook-workbench ./store/plugins/http-webhook-workbench
COPY store/plugins/performance-regression-lab ./store/plugins/performance-regression-lab
COPY store/plugins/code-migration-studio ./store/plugins/code-migration-studio
COPY store/plugins/build-reproducibility-inspector ./store/plugins/build-reproducibility-inspector
COPY store/plugins/test-doctor ./store/plugins/test-doctor
COPY store/plugins/flaky-test-lab ./store/plugins/flaky-test-lab
COPY store/plugins/documentation-doctor ./store/plugins/documentation-doctor
COPY store/plugins/release-readiness ./store/plugins/release-readiness
COPY store/plugins/repository-onboarding ./store/plugins/repository-onboarding
# Phase 87: the shared page agent her testing browser reads pages with (also in the desktop apps).
COPY desktop/shared/page-agent.js ./desktop/shared/page-agent.js
# Phase 104: the move-in collector Sara serves (Settings → Data & health → Move in from another agent).
COPY scripts/sara-movein.py ./scripts/sara-movein.py
COPY scripts/sara-movein.mjs ./scripts/sara-movein.mjs

# Root on purpose, but not a full root: the server starts as the container's root only so it can
# run her commands (shell, MCP servers) as the separate "sara-tools" user, which can't read Sara's
# data (keys, database); see src/tools/sandbox.ts. docker-compose.yml drops every capability but
# the six that needs and sets no-new-privileges. Running the whole container as an ordinary user
# (`--user 1000:1000`, with /data owned by that user) also works, but then her commands run as
# that same user and CAN read her keys, so it is the weaker choice.
RUN mkdir -p /data && chmod 711 /data
VOLUME ["/data"]
EXPOSE 7860

# Follows SARA_PORT if you change it (the container listens on every address, so ask loopback).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "try{const p=process.env.SARA_PROFILE??'personal',target='http://127.0.0.1:'+(process.env.SARA_PORT||7860)+'/api/health';if(p==='personal'){fetch(target).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))}else{if(p!=='business')throw 0;const port=Number(process.env.SARA_PORT??7860);if(!Number.isInteger(port)||port<1||port>65535)throw 0;const value=process.env.SARA_BUSINESS_ORIGIN,u=new URL(value);if(u.origin!==value||u.username||u.password||(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(u.hostname))))throw 0;require('node:http').get({hostname:'127.0.0.1',port,path:'/api/health',headers:{host:u.host},timeout:4000},r=>process.exit(r.statusCode>=200&&r.statusCode<300?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))}}catch{process.exit(1)}"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/main.ts"]
