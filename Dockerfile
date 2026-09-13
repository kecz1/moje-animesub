FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# Ręcznie utwórz folder i nadaj mu pełne prawa zapisu dla wszystkich
RUN mkdir -p /app/my-subs && chmod 777 /app/my-subs

ENV PORT=7860
ENV BASE_URL=""

EXPOSE 7860

CMD ["npm", "start"]
