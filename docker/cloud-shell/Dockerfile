# syntax=docker/dockerfile:1

# yoal-cloud-shell: the image every cloud shell runs (D236, docs/CLOUD-SHELL.md). Debian
# bookworm-slim with the yoal CLI built from this commit, Node LTS (the CLI's runtime), a pinned
# Bun, and the everyday tools a person reaches for in a terminal.
#
# At run time the helper gives it the app sandbox (own user namespace, no capabilities, no new
# privileges, read-only root, /tmp tmpfs) and mounts the person's 1 GiB home disk at /home/yoal.
# Only that disk survives a stop, so anything a person installs goes under $HOME (npm and pip are
# pointed there below). The control plane sets YOAL_URL and, when the person's role may create
# access keys, a short-lived YOAL_TOKEN, so `yoal` is signed in from the first prompt.
#
# Published by .github/workflows/release.yml as ghcr.io/<owner>/yoal-cloud-shell:<version>, the
# tag the control plane of that version asks for (override with YOAL_CLOUD_SHELL_IMAGE).

ARG BUN_VERSION=1.4.4

# The CLI bundle, built where the build runs (it is plain JavaScript, so any architecture works).
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION} AS cli
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
RUN cd apps/cli && bun run build \
 && mkdir -p /out/cli \
 && cp -r package.json README.md LICENSE dist /out/cli/

# Bun for the target architecture.
FROM oven/bun:${BUN_VERSION} AS bun

FROM debian:bookworm-slim

ARG YOAL_VERSION=dev
ARG NODE_MAJOR=22

ENV DEBIAN_FRONTEND=noninteractive \
	LANG=C.UTF-8 \
	LC_ALL=C.UTF-8 \
	TERM=xterm-256color

RUN set -eux; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		ca-certificates curl gnupg tini bash bash-completion less nano vim-tiny \
		git openssh-client jq unzip zip xz-utils zstd tar gzip make python3 python3-venv \
		procps htop dnsutils iputils-ping netcat-openbsd \
		postgresql-client redis-tools; \
	install -d -m 0755 /etc/apt/keyrings; \
	curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg; \
	echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list; \
	apt-get update; \
	apt-get install -y --no-install-recommends nodejs; \
	apt-get clean; \
	rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=cli /out/cli /opt/yoal-cli

# `npm install` in place fetches the CLI's one runtime dependency (esbuild, for functions) for
# this architecture; `yoal` is then the bundle itself.
RUN set -eux; \
	ln -s /usr/local/bin/bun /usr/local/bin/bunx; \
	cd /opt/yoal-cli; \
	npm install --omit=dev --no-audit --no-fund; \
	chmod 0755 dist/yoal.js; \
	ln -s /opt/yoal-cli/dist/yoal.js /usr/local/bin/yoal; \
	yoal --version > /etc/yoal-cli-version; \
	echo "${YOAL_VERSION}" > /etc/yoal-cloud-shell-release; \
	groupadd --gid 1000 yoal; \
	useradd --uid 1000 --gid yoal --home-dir /home/yoal --create-home --shell /bin/bash yoal

COPY docker/cloud-shell/bashrc /etc/yoal-cloud-shell.bashrc
COPY docker/cloud-shell/init.sh /usr/local/bin/yoal-cloud-shell-init
RUN chmod 0755 /usr/local/bin/yoal-cloud-shell-init \
 && cat /etc/yoal-cloud-shell.bashrc >> /etc/bash.bashrc

USER yoal
WORKDIR /home/yoal

# Everything a person installs lands on the home disk, the one place that survives a stop.
ENV HOME=/home/yoal \
	NPM_CONFIG_PREFIX=/home/yoal/.local \
	BUN_INSTALL=/home/yoal/.bun \
	PIP_USER=1 \
	PATH=/home/yoal/.local/bin:/home/yoal/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

LABEL org.opencontainers.image.title="yoal-cloud-shell" \
	org.opencontainers.image.description="Yoal cloud shell: a terminal with the yoal CLI signed in" \
	org.opencontainers.image.version="${YOAL_VERSION}"

# tini reaps whatever the console's shells leave behind; the init script only seeds a fresh disk
# and then waits. People reach the container through `podman exec` from the console (D127).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/yoal-cloud-shell-init"]
