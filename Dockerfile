FROM stefanscherer/node-windows

WORKDIR C:/usr/src/app
COPY . .
RUN npm install -g pm2@latest
RUN npm ci

ENV FXSERVER_IN_DOCKER=1
EXPOSE 40121

CMD ["C:/usr/src/app/run.ps1"]
