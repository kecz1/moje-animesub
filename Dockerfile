FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV PORT=7860
ENV BASE_URL=""

EXPOSE 7860

CMD ["npm", "start"]
