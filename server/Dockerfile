FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY src ./src
COPY schema.sql ./schema.sql
EXPOSE 5000
CMD ["npm", "start"]
