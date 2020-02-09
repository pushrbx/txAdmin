FROM stefanscherer/node-windows

WORKDIR C:/usr/src/app
COPY . .
RUN npm install -g pm2@latest
RUN npm ci

CMD ["C:/usr/src/app/run.ps1"]
