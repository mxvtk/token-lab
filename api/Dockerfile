FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 3001
# Seed on boot (idempotent), then start the API.
CMD ["sh", "-c", "npm run seed && npm start"]
