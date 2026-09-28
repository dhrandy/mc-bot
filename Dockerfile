FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /data/auth && chown -R node:node /data
COPY --chown=node:node src ./src
USER node
EXPOSE 42883
CMD ["node", "src/index.js"]
