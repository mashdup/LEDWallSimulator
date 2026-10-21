# The relay is one Node process and the repo's core/, web/ pages. No build,
# no dependencies, no bundler: the image is a runtime and the source.
FROM node:22-alpine

WORKDIR /app
COPY core/ ./core/
COPY web/ ./web/
COPY relay/ ./relay/
COPY tools/ ./tools/
COPY package.json ./

# The gallery, the wall key and the owner token live under RELAY_DATA's
# directory. The compose file mounts a volume at /data and sets this path to
# match: losing that directory means losing the party's drawings, so it is a
# volume and not the image's filesystem.
ENV RELAY_DATA=/data/drawings.json     RELAY_TRUSTED_PROXY=1
VOLUME ["/data"]

EXPOSE 8080
CMD ["node", "relay/server.js"]
