FROM node:22-alpine

WORKDIR /app

COPY --chown=user package*.json ./
RUN npm ci --only=production

COPY --chown=user . .

ENV PORT=7860
ENV BASE_URL=""

USER node

EXPOSE 7860

CMD ["npm", "start"]
