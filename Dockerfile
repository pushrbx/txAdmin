FROM stefanscherer/node-windows

WORKDIR C:/usr/src/app
COPY . .
RUN npm install -g pm2@latest && npm ci

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
      CMD node C:/usr/src/app/healthcheck.js

VOLUME "C:/usr/src/app/data"
ENV FXSERVER_IN_DOCKER=1
ENV TMP_EXEC_FILE_PATH="C:/usr/src/app/data/default/data/exec.tmp.cfg"
EXPOSE 40121

CMD ["C:/usr/src/app/run.cmd"]
