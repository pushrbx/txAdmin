FROM mcr.microsoft.com/windows/servercore:1809

WORKDIR "C:\\fxserver"
SHELL ["powershell", "-Command", "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';"]

RUN Invoke-WebRequest -OutFile vc_redist.exe -UseBasicParsing "https://aka.ms/vs/16/release/VC_redist.x64.exe";\
    .\vc_redist.exe /install /passive /norestart;\
	Invoke-WebRequest -OutFile server.zip -UseBasicParsing "https://runtime.fivem.net/artifacts/fivem/build_server_windows/master/2083-e706306f033fbc9adf69ceb2104412a3bcb547e1/server.zip";\
	Expand-Archive -Path server.zip -DestinationPath .;\
	rm .\vc_redist.exe;\
	rm server.zip;

VOLUME "C:\fxserver\server-data"
EXPOSE 30130

WORKDIR "C:\\fxserver\\server-data"
ENTRYPOINT ["C:\\fxserver\\FXServer.exe", "+set", "citizen_dir", "C:\\fxserver\\citizen"]
