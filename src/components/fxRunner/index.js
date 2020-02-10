//Requires
const { spawn } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const sleep = require('util').promisify(setTimeout);
const pidtree = require('pidtree');
const { dir, log, logOk, logWarn, logError, cleanTerminal } = require('../../extras/console');
const helpers = require('../../extras/helpers');
const defer = require('../../extras/defer');
const Deferred = defer.Deferred;
const resourceInjector = require('./resourceInjector');
const ConsoleBuffer = require('./consoleBuffer');
const context = 'FXRunner';
const Docker = require('dockerode');
const net = require('net');
const _ = require('lodash');

//Helpers
const now = () => { return Math.round(new Date() / 1000) };


module.exports = class FXRunner {
    constructor(config) {
        logOk('::Started', context);
        this.config = config;
        this.spawnVariables = null;
        this.fxChild = null;
        this.tsChildStarted = null;
        this.fxServerPort = null;
        this.extResources = [];
        // ==== docker stuff ====
        this.dockerClient = null;
        this.serverContainerId = null;
        this.serverContainerStdIn = new net.Socket({writable: true});
        this.serverContainerStdOut = new net.Socket({readable: true});
        this.serverContainerStdErr = new net.Socket({readable: true});
        // ==== /docker stuff ====
        this.consoleBuffer = new ConsoleBuffer(this.config.logPath, 10);
        this.tmpExecFile = path.normalize(process.cwd()+`/${globals.config.serverProfilePath}/data/exec.tmp.cfg`);
        this.setupVariables();

        //The setTimeout is not strictly necessary, but it's nice to have other errors in the top before fxserver starts.
        if(config.autostart){
            setTimeout(() => {
                this.spawnServer(true);
            }, config.autostartDelay * 1000);
        }
    }


    //================================================================
    /**
     * Refresh fxRunner configurations
     */
    refreshConfig(){
        this.config = globals.configVault.getScoped('fxRunner');
        this.setupVariables();
    }//Final refreshConfig()


    //================================================================
    /**
     * Setup the spawn variables
     */
    setupVariables(){
        let onesyncFlag = (this.config.onesync)? '+set onesync_enabled 1' : '';
        if (this.isDockerContainerSpawnMode()) {
            this.dockerClient = new Docker();
        }
        if (globals.config.osType === 'Linux'){
            this.spawnVariables = {
                shell: '/bin/sh',
                cmdArgs: [`${this.config.buildPath}/run.sh`, `${onesyncFlag} +exec "${this.tmpExecFile}"`]
            };
        } else if(globals.config.osType === 'Windows_NT'){
            this.spawnVariables = {
                shell: 'cmd.exe',
                cmdArgs: ['/c', `${this.config.buildPath}/run.cmd ${onesyncFlag} +exec "${this.tmpExecFile}"`]
            };
        } else{
            logError(`OS type not supported: ${globals.config.osType}`, context);
            process.exit();
        }
    }//Final setupVariables()

    isDockerContainerSpawnMode() {
        return process.env.FXSERVER_IN_DOCKER && process.env.FXSERVER_IN_DOCKER === "1";
    }

    getFxServerContainer() {
        if (this.serverContainerId === null) {
            return null;
        }
        return this.dockerClient.getContainer(this.serverContainerId);
    }


    //================================================================
    /**
     * Spawns the FXServer and sets up all the event handlers
     * @param {boolean} announce
     * @returns {string} null or error message
     */
    async spawnServer(announce){
        log("Starting FXServer", context);
        //Sanity Check
        if(
            this.spawnVariables == null ||
            typeof this.spawnVariables.shell == 'undefined' ||
            typeof this.spawnVariables.cmdArgs == 'undefined'
        ){
            return logError('this.spawnVariables is not set.', context);
        }
        //If the any FXServer configuration is missing
        if(
            this.config.buildPath === null ||
            this.config.basePath === null ||
            this.config.cfgPath === null
        ) {
            return logError('Cannot start the server with missing configuration (buildPath || basePath || cfgPath).', context);
        }
        //If the server is already alive
        if (this.fxChild !== null || (this.isDockerContainerSpawnMode() && this.serverContainerId !== null)) {
            return logError('The server is already started.', context);
        }

        //Refresh resource cache
        await this.injectResources();

        //Write tmp exec file
        let execFilePath = await this.writeExecFile(false, true);
        if(!execFilePath) return logError('Failed to write exec file. Check terminal.', context);

        //Detecting endpoint port
        try {
            let cfgFilePath = helpers.resolveCFGFilePath(this.config.cfgPath, this.config.basePath);
            let rawCfgFile = helpers.getCFGFileData(cfgFilePath);
            this.fxServerPort = helpers.getFXServerPort(rawCfgFile);
        } catch (error) {
            let errMsg =  logError(`FXServer config error: ${error.message}`, context);
            //the IF below is only a way to disable the endpoint check
            if(globals.config.forceFXServerPort){
                this.fxServerPort = globals.config.forceFXServerPort;
            }else{
                return errMsg;
            }
        }

        //Sending header to the console buffer
        this.consoleBuffer.writeHeader();

        //Resseting hitch counter
        globals.monitor.clearFXServerHitches();

        //Announcing
        if(announce === 'true' || announce === true){
            let discordMessage = globals.translator.t('server_actions.spawning_discord', {servername: globals.config.serverName});
            globals.discordBot.sendAnnouncement(discordMessage);
        }

        //Starting server
        if (this.isDockerContainerSpawnMode()) {
            await this.spawnServerAsDockerContainer();
        } else {
            this.spawnServerAsChildProcess();
        }

        return null;
    }//Final spawnServer()

    async createFxServerContainer(imageName) {
        if (!imageName) {
            throw new Error("Failed to create fx server container. The resolved image name for the creation was invalid.");
        }
        // todo: container recreation if onesync setting changes.
        const serverPort = this.fxServerPort ? this.fxServerPort : 30130;
        const volumeMountsExpr = this.config.serverDataVolumeMount.split(":");
        if (volumeMountsExpr.length !== 4 && volumeMountsExpr.length !== 2) {
            throw new Error("Config error: invalid volume mount expression.")
        }
        let onesyncFlag = (this.config.onesync) ? '+set onesync_enabled 1' : '';
        let containerCmd;
        // cmdArgs: ['/c', `${this.config.buildPath}/run.cmd ${onesyncFlag} +exec "${this.tmpExecFile}
        let tmpExecFilePathInServerContainer;
        let tmpExecFilePath = this.tmpExecFile;
        if (globals.config.osType === 'Linux') {
            tmpExecFilePathInServerContainer = `/srv/fxserver/extra`;
            containerCmd = ["/srv/fxserver/run.sh", onesyncFlag, "+exec", `${tmpExecFilePathInServerContainer}/${path.basename(process.env.TMP_EXEC_FILE_PATH)}`];
        } else if (globals.config.osType === 'Windows_NT') {
            tmpExecFilePath = tmpExecFilePath.replace("/", "\\");
            tmpExecFilePathInServerContainer = `C:\\extra\\${path.basename(process.env.TMP_EXEC_FILE_PATH)}`;
            containerCmd = ["C:\\fxserver\\run.cmd", onesyncFlag, "+exec", `${tmpExecFilePathInServerContainer}\\${path.basename(process.env.TMP_EXEC_FILE_PATH)}`];
        } else {
            throw new Error("Unsupported OS.");
        }

        tmpExecFilePath = path.dirname(tmpExecFilePath);

        const container = await this.dockerClient.createContainer({
            _query: {
                name: this.config.containerName
            },
            Image: imageName,
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,
            OpenStdin: true,
            Cmd: containerCmd,
            HostConfig: {
                PortBindings: {
                    [`${serverPort}/tcp`]: [
                        {
                            HostPort: `${serverPort}`
                        }
                    ],
                    [`${serverPort}/udp`]: [
                        {
                            HostPort: `${serverPort}`
                        }
                    ]
                },
                Binds: [
                    this.config.serverDataVolumeMount,
                    `${tmpExecFilePath}:${tmpExecFilePathInServerContainer}`
                ]
            }
        });

        if (container) {
            return container;
        } else {
            throw new Error("Couldnt create the server's container.");
        }
    }

    async setupSocketsForContainer(container) {
        if (!container) {
            throw new Error("Failed to create fx server container. The resolved container object for the creation was invalid.");
        }

        this.serverContainerStdIn.on('error', () => {});
        this.serverContainerStdIn.on('data', () => {});

        this.serverContainerStdOut.on('error', () => {});
        this.serverContainerStdOut.on('data', this.consoleBuffer.write.bind(this.consoleBuffer));

        this.serverContainerStdErr.on('error', () => {});
        this.serverContainerStdErr.on('data', this.consoleBuffer.writeError.bind(this.consoleBuffer));

        const serverStream = await container.attach({ stream: true, stdout: true, stdin: true, hijack: true });
        if (serverStream) {
            // todo: figure out when we write to stdIn socket does it close it?
            this.serverContainerStdIn.pipe(serverStream);
            container.modem.demuxStream(serverStream, this.serverContainerStdOut, this.serverContainerStdErr);
            container.wait(() => {
                logWarn(`>> FXServer Closed. (CID: ${this.serverContainerId})`);
                this.serverContainerStdIn.end();
                this.serverContainerStdErr.end();
                this.serverContainerStdOut.end();
                if (serverStream) {
                    serverStream.socket.end();
                }
            });
        }
    }

    async setupContainerSocketsAndStart(container) {
        if (!container) {
            throw new Error("Failed to create fx server container. The resolved container object for the creation was invalid.");
        }
        let containerData = await container.inspect();
        if (!containerData.State.Running) {
            await container.start();
            containerData = await container.inspect();
        }

        if (containerData.State.Running) {
            await this.setupSocketsForContainer(container);
        } else {
            throw new Error("Failed to start fx server container.");
        }

        this.serverContainerId = containerData.Id;
        logOk(`FXServer started as a docker container! Container id: ${this.serverContainerId}`);
    }

    async spawnServerAsDockerContainer() {
        try {
            const imageName = this.config.serverDockerImageName ? this.config.serverDockerImageName : "fxserver";
            // check if fxserver's container exists
            const containers = await this.dockerClient.listContainers({
                "filters": {
                    "status": [ "exited", "running", "created" ]
                }
            });
            const serverContainer = _.find(containers, x => x.Image.indexOf(imageName) > -1 || x.Image === imageName);
            if (!serverContainer) {
                const images = await this.dockerClient.listImages();
                if (images) {
                    const serverImage = _.find(images, x => !!_.find(x.RepoTags, y => y.indexOf(imageName) > -1));
                    if (!serverImage) {
                        // try to pull image, hoping the image name is in repoTag format
                        try {
                            const stream = await this.dockerClient.pull(imageName);
                            const deferred = new Deferred();
                            const th = this;
                            this.dockerClient.modem.followProgress(stream, function() {
                                // on finished.
                                th.createFxServerContainer(imageName).then(c => {
                                    deferred.resolve(c);
                                }).catch(e => deferred.reject(e));
                            });
                            const createdServerContainer = await deferred.promise;
                            await this.setupContainerSocketsAndStart(createdServerContainer);
                        } catch (e) {
                            logError('Failed to start FXServer. The docker image for FXServer is missing. Please build it first.');
                        }
                    } else {
                        // serverImage exists, hurray.
                        const createdServerContainer = await this.createFxServerContainer(_.head(serverImage.RepoTags));
                        await this.setupContainerSocketsAndStart(createdServerContainer);
                    }
                }
            } else {
                // container exists, hurray.
                // todo: sanity check of the container. Possible use case: the txAdmin has been moved to a different folder, but the container
                //       metadata still holds the old volume binding configuration. (we mount the exec cfg from txadmin's folder on the container)
                const container = this.dockerClient.getContainer(serverContainer.Id);
                await this.setupContainerSocketsAndStart(container);
            }
        } catch (e) {
            logError(`There was a problem during the fxserver spawn operation: ${e}`, context);
        }
    }

    spawnServerAsChildProcess() {
        let pid;
        let tsStart = now();
        try {
            this.fxChild = spawn(
                this.spawnVariables.shell,
                this.spawnVariables.cmdArgs,
                {cwd: this.config.basePath}
            );
            pid = this.fxChild.pid.toString();
            logOk(`:: [${pid}] FXServer Started!`, context);
            this.tsChildStarted = tsStart;
        } catch (error) {
            logError('Failed to start FXServer with the following error:');
            dir(error);
            process.exit(0);
        }

        // Setting up stream handlers
        this.fxChild.stdout.setEncoding('utf8');
        //process.stdin.pipe(this.fxChild.stdin);

        // Setting up event handlers
        this.fxChild.on('close', function (code, signal) {
            logWarn(`>> [${pid}] FXServer Closed. (code ${code})`, context);
        });
        this.fxChild.on('disconnect', function () {
            logWarn(`>> [${pid}] FXServer Disconnected.`, context);
        });
        this.fxChild.on('error', function (err) {
            logWarn(`>> [${pid}] FXServer Errored:`, context);
            dir(err)
        });
        this.fxChild.on('exit', function (code, signal) {
            process.stdout.write("\n"); //Make sure this isn't concatenated with the last line
            logWarn(`>> [${pid}] FXServer Exited.`, context);
            if(now() - tsStart <= 5){
                setTimeout(() => {
                    if(globals.config.osType === 'Windows_NT'){
                        logWarn(`FXServer didn't started. This is not an issue with txAdmin. Make sure you have Visual C++ 2019 installed.`, context)
                    }else{
                        logWarn(`FXServer didn't started. This is not an issue with txAdmin.`, context)
                    }
                }, 500);
            }
        });

        this.fxChild.stdin.on('error', (data) => {});
        this.fxChild.stdin.on('data', (data) => {});

        this.fxChild.stdout.on('error', (data) => {});
        this.fxChild.stdout.on('data', this.consoleBuffer.write.bind(this.consoleBuffer));

        this.fxChild.stderr.on('error', (data) => {});
        this.fxChild.stderr.on('data', this.consoleBuffer.writeError.bind(this.consoleBuffer));

        //Setting up process priority
        setTimeout(() => {
            this.setProcPriority();
        }, 2500);
    }

    //================================================================
    /**
     * Inject the txAdmin resources
     */
    async injectResources(){
        try {
            await resourceInjector.resetCacheFolder(this.config.basePath);
            this.extResources = resourceInjector.getResourcesList(this.config.basePath);
            await resourceInjector.inject(this.config.basePath, this.extResources);
        } catch (error) {
            logError(`ResourceInjector Error: ${error.message}`, context);
            return false;
        }
    }


    //================================================================
    /**
     * Writes the exec.tmp.cfg file
     * @param {boolean} refresh
     * @param {boolean} start
     */
    async writeExecFile(refresh = false, start = false){
        log('Setting up FXServer temp exec file.', context);

        //FIXME: experiment
        let isEnabled;
        try {
            let dbo = globals.database.getDB();
            isEnabled = await dbo.get("experiments.bans.enabled").value();
        } catch (error) {
            logError(`[writeExecFile] Database operation failed with error: ${error.message}`, context);
            if(globals.config.verbose) dir(error);
        }
        let runExperiment = (isEnabled)? 'true' : 'false';

        //Defaults
        let timestamp = new Date().toLocaleString();
        let toExec = [
            `# [${timestamp}] This file was auto-generated by txAdmin`,
            `sets txAdmin-version "${globals.version.current}"`,
            `set txAdmin-apiPort "${globals.webServer.config.port}"`,
            `set txAdmin-apiToken "${globals.webServer.intercomToken}"`,
            `set txAdmin-clientCompatVersion "1.5.0"`,
            `set txAdmin-expBanEnabled ${runExperiment}`
        ];

        //Commands
        this.extResources.forEach((res)=>{
            toExec.push(`ensure "${res}"`);
        });

        if(refresh) toExec.push('refresh');
        if(start) {
            if (this.isDockerContainerSpawnMode()) {
                if (this.config.serverDataVolumeMount) {
                    const parts = this.config.serverDataVolumeMount.split(":");
                    let inContainerPath;
                    if (parts.length === 4) {
                        inContainerPath = [parts[2], ":", parts[3]].join("");
                    } else if (parts.length === 2) {
                        inContainerPath = parts[1];
                    } else {
                        if (globals.config.osType === "Windows_NT") {
                            inContainerPath = "C:\\fxserver\\server-data";
                        } else if (globals.config.osType === "Linux") {
                            inContainerPath = "/srv/fxserver/server-data";
                        }
                    }
                    toExec.push(`exec "${inContainerPath}${path.sep}${path.basename(this.config.cfgPath)}"`);
                } else {
                    toExec.push(`exec "C:\\fxserver\\server-data\\${path.basename(this.config.cfgPath)}"`);
                }
            } else {
                toExec.push(`exec "${this.config.cfgPath}"`);
            }
        }

        try {
            await fs.writeFile(this.tmpExecFile, toExec.join('\n'), 'utf8');
            return this.tmpExecFile;
        } catch (error) {
            logError(`Error while writing tmp exec file for the FXServer: ${error.message}`, context);
            return false;
        }
    }


    //================================================================
    /**
     * Sets the process priority to all fxChild (cmd/bash) children (fxserver)
     */
    async setProcPriority(){
        if (this.isDockerContainerSpawnMode()) {
            return;
        }
        //Sanity check
        if(typeof this.config.setPriority !== 'string') return;
        let priority = this.config.setPriority.toUpperCase();

        if(priority === 'NORMAL') return;
        let validPriorities = ['LOW', 'BELOW_NORMAL', 'NORMAL', 'ABOVE_NORMAL', 'HIGH', 'HIGHEST'];
        if(!validPriorities.includes(priority)){
            logWarn(`Couldn't set the processes priority: Invalid priority value. (Use one of these: ${validPriorities.join()})`, context);
            return;
        }
        if(!this.fxChild.pid){
            logWarn(`Couldn't set the processes priority: Unknown PID.`, context);
            return;
        }

        //Get children and set priorities
        try {
            let pids = await pidtree(this.fxChild.pid);
            pids.forEach(pid => {
                os.setPriority(pid, os.constants.priority['PRIORITY_'+priority]);
            });
            log(`Priority set ${priority} for processes ${pids.join()}`, context)
        } catch (error) {
            logWarn("Couldn't set the processes priority.", context);
            if(globals.config.verbose) dir(error);
        }
    }


    //================================================================
    /**
     * Restarts the FXServer
     * @param {string} tReason
     */
    async restartServer(tReason) {
        if (this.isDockerContainerSpawnMode()) {
            if (this.serverContainerId) {
                const serverContainer = this.dockerClient.getContainer(this.serverContainerId);
                try {
                    // returns a truthy value, an empty Buffer object.
                    // because the status code is 204 from the API.
                    // https://docs.docker.com/engine/api/v1.40/#operation/ContainerRestart
                    const result = await serverContainer.restart();
                    if (!result) {
                        return logError("Failed to restart the container of FXServer.", context);
                    }
                } catch (e) {
                    return logError("Failed to restart the container of FXServer.", context);
                }
            }

            return null;
        }
        try {
            //If a reason is provided, announce restart on discord, kick all players and wait 500ms
            if(typeof tReason === 'string'){
                let tOptions = {
                    servername: globals.config.serverName,
                    reason: tReason
                };
                let discordMessage = globals.translator.t('server_actions.restarting_discord', tOptions);
                globals.discordBot.sendAnnouncement(discordMessage);
                let kickMessage = globals.translator.t('server_actions.restarting', tOptions).replace(/\"/g, '\\"');
                this.srvCmd(`txaKickAll "${kickMessage}"`);
                await sleep(500);
            }

            //Restart server
            this.killServer();
            await sleep(1250);
            return this.spawnServer();
        } catch (error) {
            let errMsg = logError("Couldn't restart the server.", context);
            if(globals.config.verbose) dir(error);
            return errMsg;
        }
    }


    //================================================================
    async announceServerStopAndKickAll(reason) {
        if(typeof reason !== 'string') {
            return Promise.resolve();
        }
        // If a reason is provided, announce restart on discord, kick all players and wait 500ms
        let tOptions = {
            servername: globals.config.serverName,
            reason: reason
        };
        let discordMessage = globals.translator.t('server_actions.stopping_discord', tOptions);
        globals.discordBot.sendAnnouncement(discordMessage);
        let kickMessage = globals.translator.t('server_actions.stopping', tOptions).replace(/"/g, '\\"');
        this.srvCmd(`txaKickAll "${kickMessage}"`);
        await sleep(500);
    }

    /**
     * Kills the FXServer
     * @param {string} tReason
     */
    async killServer(tReason) {
        if (this.isDockerContainerSpawnMode()) {
            let result = true;
            try {
                if (!this.serverContainerId) {
                    result = false;
                } else {
                    const serverContainer = this.dockerClient.getContainer(this.serverContainerId);
                    let containerInfo = await serverContainer.inspect();
                    if (containerInfo.State.Running) {
                        // 25 seconds timeout
                        const stopResult = await serverContainer.stop({ t: 25000 });
                        if (!stopResult) {
                            result = false;
                            logError("Failed to stop FXServer's container.");
                        } else {
                            containerInfo = await serverContainer.inspect();
                            if (containerInfo.State.Error !== '') {
                                log(`FXServer has stopped with error: ${containerInfo.State.Error}`);
                            }
                        }
                    }
                }
            } catch (e) {
                logError("Couldn't kill the server. Perhaps What Is Dead May Never Die.", context);
                if (globals.config.verbose) {
                    dir(e);
                }
            }
            return result;
        }
        try {
            await this.announceServerStopAndKickAll();

            //Stopping server
            this.fxChild.kill();
            this.fxChild = null;
            return true;
        } catch (error) {
            logError("Couldn't kill the server. Perhaps What Is Dead May Never Die.", context);
            if(globals.config.verbose) dir(error);
            this.fxChild = null;
            return false;
        }
    }


    //================================================================
    /**
     * Pipe a string into FXServer's stdin (aka executes a cfx's command)
     * @param {string} command
     */
    srvCmd(command){
        if(typeof command !== 'string') throw new Error('Expected String!');
        if(this.fxChild === null) return false;
        try {
            let success;
            if (!this.isDockerContainerSpawnMode()) {
                success = this.fxChild.stdin.write(command + "\n");
            } else {
                success =  this.serverContainerStdIn.write(command + "\n");
            }
            globals.webConsole.buffer(command, 'command');
            return success;
        } catch (error) {
            if(globals.config.verbose){
                logError('Error writing to fxChild.stdin', context);
                dir(error);
            }
            return false;
        }
    }


    //================================================================
    /**
     * Pipe a string into FXServer's stdin (aka executes a cfx's command) and returns the stdout output.
     * @param {*} command
     * @param {*} bufferTime the size of the buffer in milliseconds
     * @returns {string} buffer
     */
    async srvCmdBuffer(command, bufferTime){
        if(typeof command !== 'string') throw new Error('Expected String!');
        if(this.fxChild === null) return false;
        bufferTime = (bufferTime !== undefined)? bufferTime : 1500;
        this.consoleBuffer.cmdBuffer = '';
        this.consoleBuffer.enableCmdBuffer = true;
        let result = this.srvCmd(command);
        if(!result) return false;
        await sleep(bufferTime);
        this.consoleBuffer.enableCmdBuffer = false;
        return this.consoleBuffer.cmdBuffer;
    }

} //Fim FXRunner()
