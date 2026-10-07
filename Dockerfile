FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy application files
COPY . .

# Application port
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
