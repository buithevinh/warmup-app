# Dùng Node.js chính thức
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package.json và package-lock.json
COPY package*.json ./

# Cài dependencies
RUN npm install --production

# Copy toàn bộ source code
COPY . .

# Expose port (ClawCloud Run sẽ cung cấp PORT)
EXPOSE 8080

# Chạy app
CMD ["node", "index.js"]
