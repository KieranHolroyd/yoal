# S4 ingress: Yoal's pinned Caddy build (.github/workflows/release.yml: Caddy 2.11.8, xcaddy v0.4.7,
# caddy-dns/cloudflare v0.2.4) plus ONE certmagic S3 storage module, chosen by STORAGE_MODULE:
#   github.com/techknowlogick/certmagic-s3@v1.5.0  (lock by If-None-Match/If-Match; design A)
#   github.com/ss098/certmagic-s3@<commit>         (Lock() is a no-op; the "no lock" control)
# Both register caddy.storage.s3, so they cannot share one binary. Bun is copied in for the
# design-B agent (agent.ts). Lab image only; Yoal itself runs no Docker daemon.
ARG GO_VERSION=1.24
FROM oven/bun:1.4.4 AS bun
FROM golang:${GO_VERSION}-alpine AS build
ARG CADDY_VERSION=2.11.8
ARG CADDY_DNS_CLOUDFLARE_VERSION=v0.2.4
ARG XCADDY_VERSION=v0.4.7
ARG STORAGE_MODULE
# certmagic-s3 v1.5.0 declares go 1.26.0; GOTOOLCHAIN=auto fetches it (release.yml's setup-go does too).
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
RUN apk add --no-cache git && go install "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}" \
 && xcaddy build "v${CADDY_VERSION}" \
      --with "github.com/caddy-dns/cloudflare@${CADDY_DNS_CLOUDFLARE_VERSION}" \
      --with "${STORAGE_MODULE}" --output /caddy \
 && /caddy version && /caddy build-info | grep -E 'caddyserver/(caddy|certmagic)|certmagic-s3|^go' > /build-info.txt

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl tini ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* && groupadd --system caddy && useradd --system -g caddy -d /var/lib/caddy -m caddy
COPY --from=build /caddy /usr/bin/caddy
COPY --from=build /build-info.txt /etc/s4-build-info.txt
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENTRYPOINT ["/usr/bin/tini", "--"]
