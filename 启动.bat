@echo off

title MyDesk 个人行情工作台

cd /d "%~dp0"



echo ============================================

echo    MyDesk 个人行情工作台 - 一键启动

echo ============================================

echo.



REM === 1. 检测 Node.js ===

where node >nul 2>nul

if errorlevel 1 (

  echo  [!] 未检测到 Node.js，请先安装：

  echo      1. 打开 https://nodejs.org/

  echo      2. 下载带 LTS 字样的版本（v20 或更高）

  echo      3. 一路点"下一步"装完

  echo      4. 关掉本窗口，重新双击 启动.bat

  echo.

  pause

  exit /b 1

)

for /f "tokens=*" %%v in ('node -v') do echo  [OK] 已检测到 Node.js %%v



REM === 2. 确保 .env 存在 ===

if not exist ".env" (

  echo DATABASE_URL=file:./db/custom.db>.env

)



REM === 3. 配置国内 npm 镜像 ===

call npm config set registry https://registry.npmmirror.com/

echo  [OK] 已切换到国内 npm 镜像 npmmirror.com



REM === 4. 安装依赖（首次需要几分钟）===

if not exist "node_modules\next\package.json" (

  echo  [1/4] 首次启动：正在安装依赖，需要几分钟，请勿关闭窗口...

  call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com/

  if errorlevel 1 (

    echo  [!] 依赖安装失败，请检查上方报错信息。

    pause

    exit /b 1

  )

  echo  [OK] 依赖安装完成！

) else (

  echo  [OK] 已检测到依赖，跳过安装步骤

)



REM === 5. 生成 Prisma Client ===

if not exist "node_modules\.prisma\client\index.js" (

  echo  [2/4] 正在初始化数据库客户端（约 10 秒）...

  call npx prisma generate

  if errorlevel 1 (

    echo  [!] 数据库初始化失败，请检查上方报错信息。

    pause

    exit /b 1

  )

  echo  [OK] 数据库客户端就绪

) else (

  echo  [OK] 数据库客户端已存在

)



REM === 6. 启动 Next.js 服务 ===

echo.

echo  [3/4] 正在启动本地服务...

echo        - 看到 Ready 或 Local: 字样即启动成功

echo        - 浏览器将自动打开 http://localhost:3000

echo        - 停止方法：直接关闭本窗口

echo.



REM === 境外AI接口走本机代理(v2rayN 等，默认混合端口 10808) ===
REM 国内行情源(腾讯/东财)在 NO_PROXY 白名单里，保持直连不受影响
REM 若代理端口不同请改 10808；不用代理则删除下面三行 set
set NODE_USE_ENV_PROXY=1
set HTTPS_PROXY=http://127.0.0.1:10808
set HTTP_PROXY=http://127.0.0.1:10808
set NO_PROXY=localhost,127.0.0.1,gtimg.cn,eastmoney.com,qq.com

start "" /b cmd /c "%SystemRoot%\System32\ping.exe -n 13 127.0.0.1 >nul & start "" http://localhost:3000"



echo  [4/4] 服务运行中（请勿关闭本窗口）

echo.

call npx next dev -p 3000



echo.

echo  服务已停止。重新双击 启动.bat 即可再次使用。

pause

