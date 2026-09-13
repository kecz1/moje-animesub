FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

# Skopiuj pliki i od razu ustaw użytkownika 'node' jako właściciela katalogu /app
COPY --chown=node:node . .

ENV PORT=7860
ENV BASE_URL=""

USER node

EXPOSE 7860

CMD ["npm", "start"]
