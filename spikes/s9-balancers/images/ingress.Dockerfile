# S9 ingress: the pinned Caddy build (as .github/workflows/release.yml builds it) plus keepalived.
# Lab image only; Yoal itself runs no Docker daemon.
ARG GO_VERSION=1.24
FROM golang:${GO_VERSION}-alpine AS build
ARG CADDY_VERSION=2.11.8
ARG CADDY_DNS_CLOUDFLARE_VERSION=v0.2.4
ARG XCADDY_VERSION=v0.4.7
# setup-go on the release runner lets go.mod pick a newer toolchain; the golang image pins it local.
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
RUN apk add --no-cache git && go install "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" \
 && xcaddy build "v${CADDY_VERSION}" --with "github.com/caddy-dns/cloudflare@${CADDY_DNS_CLOUDFLARE_VERSION}" --output /caddy \
 && /caddy version

# Debian 13, the OS Yoal targets; its keepalived has track_process (Alpine's does not).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends keepalived curl tini iproute2 procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /caddy /usr/bin/caddy
COPY ingress-entry.sh /usr/local/bin/ingress-entry
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/ingress-entry"]
