@echo off

title MyDesk 个人行情工作台

cd /d "%~dp0"

REM ============================================================

REM  启动方式：常驻生产服务（next build + next start）

REM  后台自动扫描（交易日收盘后自动跑 Radar / Events）挂在这个进程上：

REM  浏览器可以关，本窗口不能关；关掉本窗口 = 服务与自动扫描一起停止。

REM

REM  用法：

REM    双击 启动.bat          正常启动（已有构建产物则跳过构建）

REM    启动.bat rebuild       改过代码后强制重新构建再启动

REM    启动.bat dev           退回开发模式（改代码即时生效，自动化同样会跑）

REM    启动.bat 3011          换一个端口启动
REM
REM  本脚本会自动拉起通达信行情网关 eltdx（已在运行则跳过，不会重复启动）：
REM    - 通达信行情网关 eltdx（端口 8756）：大盘成交额/日K/五档的主数据源。
REM      没它时行情降级到腾讯备源，而腾讯日K不含成交额 —— 大盘成交额趋势会只剩一根柱。
REM  模型通道已改为 .env 里的云 API（DeepSeek-V4-Flash），不再需要豆包网关 doubao2API。
REM    如需切回本机豆包网关：先 set MYDESK_DOUBAO_GATEWAY=1，再启动本脚本。
REM
REM ============================================================

set "PORT=3000"

if /i "%~1"=="rebuild" (set "MYDESK_FORCE_BUILD=1") else (if /i "%~1"=="dev" (set "MYDESK_MODE=dev") else (if not "%~1"=="" set "PORT=%~1"))

echo ============================================

echo    MyDesk 个人行情工作台 - 一键启动（生产模式）

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

  echo  [1/5] 首次启动：正在安装依赖，需要几分钟，请勿关闭窗口...

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

  echo  [2/5] 正在初始化数据库客户端（约 10 秒）...

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

REM === 6. 构建生产包（开发模式不需要）===

if "%MYDESK_MODE%"=="dev" goto skip_build

if not exist ".next\BUILD_ID" set "MYDESK_FORCE_BUILD=1"

if defined MYDESK_FORCE_BUILD (

  echo  [3/5] 正在构建生产包，首次约需 1~3 分钟，请勿关闭窗口...

  call npx next build --webpack

  if errorlevel 1 (

    echo  [!] 构建失败，请检查上方报错信息。

    echo      可先用「启动.bat dev」回到开发模式定位问题。

    pause

    exit /b 1

  )

  echo  [OK] 构建完成

) else (

  echo  [OK] 已有构建产物，跳过构建（改过代码请用「启动.bat rebuild」）

)

:skip_build

REM === 境外AI接口走本机代理(v2rayN 等，默认混合端口 10808) ===

REM 国内行情源(腾讯/东财/新浪)在 NO_PROXY 白名单里，保持直连不受影响

REM 若代理端口不同请改 10808；不用代理则删除下面三行 set

set NODE_USE_ENV_PROXY=1

set HTTPS_PROXY=http://127.0.0.1:10808

set HTTP_PROXY=http://127.0.0.1:10808

set NO_PROXY=localhost,127.0.0.1,gtimg.cn,eastmoney.com,qq.com,sina.com.cn

REM === 启动通达信(eltdx)行情网关（端口 8756，主行情源；未安装则自动跳过走腾讯/东财） ===

set "TDX_EXE=%LocalAppData%\Programs\Python\Python314\Scripts\eltdx-http.exe"

if exist "%TDX_EXE%" (

  netstat -ano | findstr ":8756 " | findstr "LISTENING" >nul 2>nul

  if errorlevel 1 (

    echo  [OK] 正在启动通达信行情网关 eltdx（端口 8756）...

    start "" /b "%TDX_EXE%" --host 127.0.0.1 --port 8756 --server-count 2 --connections-per-server 2

  ) else (

    echo  [OK] 通达信行情网关已在运行（端口 8756）

  )

) else (

  echo  [--] 未检测到 eltdx 网关，行情走腾讯/东财公开接口

)

REM === 启动豆包(doubao2API)AI网关（可选：默认跳过，需 set MYDESK_DOUBAO_GATEWAY=1 才启动） ===

set "DOUBAO_DIR=D:\doubao2API-main"

if not defined MYDESK_DOUBAO_GATEWAY (
  echo  [--] 已跳过豆包网关（模型通道已改为 .env 云 API；需要时先 set MYDESK_DOUBAO_GATEWAY=1）
) else if exist "%DOUBAO_DIR%\start.py" (

  netstat -ano | findstr ":7861 " | findstr "LISTENING" >nul 2>nul

  if errorlevel 1 (

    echo  [OK] 正在启动豆包 AI 网关 doubao2API（端口 7861）...

    pushd "%DOUBAO_DIR%"

    start "" /b cmd /c "python start.py > gateway-boot.log 2>&1"

    popd

  ) else (

    echo  [OK] 豆包 AI 网关已在运行（端口 7861）

  )

) else (

  echo  [--] 未检测到豆包网关（%DOUBAO_DIR%），产业链研报走 .env 里的官方 API 模式

)

REM === 7. 端口占用检测：多半是本窗口重复双击，服务已在跑 ===

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul

if not errorlevel 1 (

  echo.

  echo  [!] 端口 %PORT% 已经有服务在监听，不再重复启动。

  echo      若那就是 MyDesk（多半如此），直接打开 http://localhost:%PORT% 即可；

  echo      若要同时跑第二个实例，用「启动.bat 3011」换个端口。

  echo      若端口被别的程序占了，先结束它或换端口。

  echo.

  pause

  exit /b 0

)

REM === 8. 启动服务 ===

echo.

if "%MYDESK_MODE%"=="dev" (

  echo  [4/5] 开发模式启动（改代码即时生效；后台自动扫描同样会随本进程运行）

) else (

  echo  [4/5] 正在启动本地服务（生产模式 next start）

)

echo        - 看到 Ready 或 Local: 字样即启动成功

echo        - 生产模式下若提示 output standalone 相关警告，可忽略，功能正常

echo        - 浏览器将自动打开 http://localhost:%PORT%

echo        - 停止方法：直接关闭本窗口（自动扫描也会随之停止）

echo.

start "" /b cmd /c "%SystemRoot%\System32\ping.exe -n 13 127.0.0.1 >nul & start "" http://localhost:%PORT%"

echo  [5/5] 服务运行中（请勿关闭本窗口）

echo.

if "%MYDESK_MODE%"=="dev" (

  call npx next dev -p %PORT% --webpack

) else (

  call npx next start -p %PORT%

)

echo.

echo  服务已停止。重新双击 启动.bat 即可再次使用。

pause

