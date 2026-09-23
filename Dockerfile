# Multi-stage build packaging the `epic` binary into a small runtime image.
#
# Designed to run on AWS. For Graviton (ARM64) instances / Fargate, build with:
#   docker buildx build --platform linux/arm64 -t epic:latest --load .
# For x86_64, use --platform linux/amd64 (or just `docker build .` on an x86 host).
#
# The image is deliberately minimal: it contains only the statically-friendly
# release binary on a Debian slim base. Data is NOT baked in — mount it or pull
# from S3 at run time (see docs/AWS.md).

# ---- build stage ------------------------------------------------------------
FROM rust:1-slim AS build

WORKDIR /src

# Corporate TLS interception (e.g. Zscaler): the proxy re-signs HTTPS with its
# own root CA, so crates.io downloads fail with "unable to get local issuer
# certificate" unless that root is trusted. We vendor the CA into the build
# context and register it before any network call. This is a no-op off-network
# (the cert simply becomes an additional trusted root).
COPY build/certs/ /usr/local/share/ca-certificates/
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Point cargo/curl and openssl at the system bundle that now includes the CA.
ENV CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

# Cache dependencies in their own layer: copy the manifests and fetch crates
# against the committed Cargo.lock. This layer only re-runs when the manifests
# change, so ordinary source edits reuse the cached crate downloads.
COPY rust/Cargo.toml rust/Cargo.lock ./
RUN cargo fetch --locked

# Now the real sources. Build offline against the already-fetched crates so the
# build layer needs no network.
COPY rust/src ./src
RUN cargo build --release --offline \
    && strip target/release/epic

# ---- runtime stage ----------------------------------------------------------
FROM debian:stable-slim AS runtime

# ca-certificates for TLS; awscli + bash so the entrypoint can sync data to/from
# S3 (the container becomes self-contained for a Batch run). awscli from Debian
# is fine here and available for arm64/amd64 without extra install steps.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates awscli bash \
    && rm -rf /var/lib/apt/lists/*

# Run as a non-root user, with /data writable for synced inputs/outputs.
RUN useradd --create-home --uid 10001 epic \
    && mkdir -p /data \
    && chown epic:epic /data
USER epic
WORKDIR /home/epic

COPY --from=build /src/target/release/epic /usr/local/bin/epic
# Copy as root and make executable (COPY can drop the exec bit), then it's
# runnable by the non-root user.
USER root
COPY docker/entrypoint.sh /usr/local/bin/epic-entrypoint
RUN chmod 0755 /usr/local/bin/epic-entrypoint
USER epic

# Working data lives at /data at run time (host mount or S3-synced).
VOLUME ["/data"]

# The entrypoint is pass-through by default (runs `epic <args>`); it only does
# S3 sync when EPIC_INPUT_PREFIX is set. See docker/entrypoint.sh.
ENTRYPOINT ["epic-entrypoint"]
CMD ["--help"]
