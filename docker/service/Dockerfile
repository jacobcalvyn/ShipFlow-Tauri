# syntax=docker/dockerfile:1
FROM rust:1.91.1-bookworm@sha256:c1e5f19e773b7878c3f7a805dd00a495e747acbdc76fb2337a4ebf0418896b33 AS builder
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY apps ./apps
COPY crates ./crates
COPY build/release.json ./build/release.json
RUN --mount=type=cache,target=/usr/local/cargo/registry --mount=type=cache,target=/source/target \
    cargo build --locked --release -p shipflow-service && cp target/release/shipflow-service /shipflow-service

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /backup /run/shipflow && chown -R 10001:10001 /data /backup /run/shipflow
COPY --from=builder /shipflow-service /usr/local/bin/shipflow-service
ARG SHIPFLOW_RELEASE_ID
LABEL io.shipflow.release=$SHIPFLOW_RELEASE_ID
ENV SHIPFLOW_CONFIG_FILE=/run/shipflow/config.json
USER 10001:10001
WORKDIR /data
EXPOSE 18422
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=25s --start-period=30s --retries=3 CMD ["/usr/local/bin/shipflow-service", "--healthcheck"]
ENTRYPOINT ["/usr/local/bin/shipflow-service"]
