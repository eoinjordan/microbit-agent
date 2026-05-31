FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY server.js ./

RUN mkdir -p out/requests

USER node

EXPOSE 3097

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s \
  CMD wget -qO- http://localhost:3097/health || exit 1

CMD ["node", "server.js"]
