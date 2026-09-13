FROM node:22-alpine

# Utwórz użytkownika zgodnego z UID wymaganym przez HF Spaces
RUN adduser -D -u 1000 user

WORKDIR /app

COPY --chown=user package*.json ./
RUN npm ci --only=production

COPY --chown=user . .

ENV PORT=7860
ENV BASE_URL=""

USER user

EXPOSE 7860

CMD ["npm", "start"]