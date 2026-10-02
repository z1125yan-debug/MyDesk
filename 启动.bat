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

REM —— 默认开发模式（2026-09-29 用户拍板）——
REM 生产模式（next build + next start）下改代码必须重新构建才生效，否则跑的是旧构建包
REM （09-29 事故：BUILD_ID 停在 09-28 11:57，源码已改到 09-29 06:32，双击启动仍是旧版本）。
REM 改默认开发模式后：改代码即时生效，不再有"构建产物过期"这回事。
REM 用法：
REM    双击 启动.bat        开发模式（默认，改代码即时生效）
REM    启动.bat prod        生产模式（已有构建产物则跳过构建；源码更新会自动重建）
REM    启动.bat rebuild     生产模式 + 强制重新构建
REM    启动.bat 3011        换端口
set "MYDESK_MODE=dev"
if /i "%~1"=="prod" (
  set "MYDESK_MODE="
) else (
  if /i "%~1"=="rebuild" (
    set "MYDESK_MODE="
    set "MYDESK_FORCE_BUILD=1"
  ) else (
    if not "%~1"=="" set "PORT=%~1"
  )
)

echo ============================================

echo    MyDesk 个人行情工作台 - 一键启动（开发模式·改代码即时生效）

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

if not exist ".next\BUILD_ID" (
  set "MYDESK_FORCE_BUILD=1"
) else (
  REM —— 自动检查：源码是否比构建产物新 ——
  REM 旧逻辑只看 BUILD_ID 在不在，于是改过代码双击启动仍然跑旧包（2026-09-29 事故：
  REM BUILD_ID 停在 09-28 11:57，而源码已改到 09-29 06:32，差 19 小时，页面一直是旧版本）。
  REM 现在改成比对「源码最新修改时间」与「BUILD_ID 时间」，源码更新就自动重建，不用记 rebuild 参数。
  powershell -NoProfile -Command "$b=Get-Item '.next\BUILD_ID' -ErrorAction SilentlyContinue; if(-not $b){exit 1}; $f=@(); $f+=Get-ChildItem -Path 'src','scripts','public' -Recurse -File -Include *.ts,*.tsx,*.js,*.mjs,*.json -ErrorAction SilentlyContinue; $f+=@('next.config.ts','package.json','tsconfig.json') | ForEach-Object { Get-Item $_ -ErrorAction SilentlyContinue }; $s=$f | Where-Object { $_ } | Sort-Object LastWriteTime -Descending | Select-Object -First 1; if($s -and $s.LastWriteTime -gt $b.LastWriteTime){exit 1}else{exit 0}"
  if errorlevel 1 (
    set "MYDESK_FORCE_BUILD=1"
    echo  [i] 检测到源码比构建产物新，将自动重新构建（免去了手动 rebuild）
  )
)

if defined MYDESK_FORCE_BUILD (

  echo  [3/5] 正在构建生产包，首次约需 1~3 分钟，请勿关闭窗口...

  call npx next build --webpack

  if errorlevel 1 (

    echo  [!] 构建失败，请检查上方报错信息。

    echo      可直接双击「启动.bat」（默认开发模式）定位问题。

    pause

    exit /b 1

  )

  echo  [OK] 构建完成

) else (

  echo  [OK] 构建产物已是最新（源码未变更），跳过构建

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

REM === 7. 端口占用接管（P38 复检 #6 / 用户要求）===
REM    新启动发现端口 %PORT% 已被占用（可能是上一次自己跑的实例、另一个模式、或别的服务），
REM    按用户设定"直接杀掉占用者再以当前模式重启"，保证同一端口只保留一个 MyDesk 实例，
REM    不会两个实例抢端口"打架"。只杀"监听该端口的进程"（=占用者本身），不影响别的端口的服务。
REM    注：这一步会杀掉端口上正在运行的实例（无论它健不健康），符合"重启 dev"的预期；
REM        想保留现有实例、另起一个，请用「启动.bat 3011」换端口。

netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>nul
if errorlevel 1 goto port_free

set "WS_PIDS="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do call :collect_pid %%a
echo.
if defined WS_PIDS (
  echo  [i] 端口 %PORT% 已被占用（监听进程 PID：%WS_PIDS%），按设定接管：关闭占用者后重启。
) else (
  echo  [i] 端口 %PORT% 被占用但未解析到监听进程，直接重启。
)
echo %WS_PIDS%| findstr /C:" " >nul
if not errorlevel 1 (
  echo  [!] 警告：端口 %PORT% 上存在多个监听进程（%WS_PIDS%），将一并关闭。
)
REM 只杀监听该端口的进程（占用者本身），不等、不波及别的端口
if defined WS_PIDS (
  for %%p in (%WS_PIDS%) do taskkill /PID %%p /F >nul 2>nul
)
REM 等端口真正释放（最多 ~5 秒），避免新实例立刻绑定冲突"打架"
powershell -NoProfile -Command "$p=[int]'%PORT%'; for($i=0;$i-lt 10;$i++){ try{ $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if(-not $c){exit 0} }catch{}; Start-Sleep -Milliseconds 500 } exit 1"
echo       已清理占用进程，继续启动（同一端口只保留这一个实例）。
echo.
goto after_port_check

:port_free
:after_port_check

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

echo        - 停止方法：直接关闭本窗口（自动扫描也会随之停止）；dev 模式崩溃会自动重启，无需手动重开

echo.

start "" /b cmd /c "%SystemRoot%\System32\ping.exe -n 13 127.0.0.1 >nul & start "" http://localhost:%PORT%"

echo  [5/5] 服务运行中（请勿关闭本窗口）

echo.

REM === dev 模式：进程异常退出（含 dev 长跑 HMR 腐化导致的偶发崩溃）自动重启 ===
REM     正常停止请直接关闭本窗口（整棵进程树一起死，不会触发重启）；连崩 30 次判定为持续编译错误并停止，避免空转。
if "%MYDESK_MODE%"=="dev" goto dev_start
call npx next start -p %PORT%
goto after_server

:dev_start
set "DESK_DEV_RETRIES=0"
:dev_loop
call npx next dev -p %PORT% --webpack
set "DESK_DEV_RC=%errorlevel%"
set /a DESK_DEV_RETRIES+=1
if %DESK_DEV_RETRIES% GEQ 30 (
  echo  [!] dev 已连续重启 %DESK_DEV_RETRIES% 次仍退出，疑似持续编译错误；请查看上方报错，修复后重新双击 启动.bat。
  goto after_server
)
echo  [!] dev 进程于 %time% 退出（rc=%DESK_DEV_RC%），5 秒后自动重启（防 dev 长跑 HMR 腐化偶发崩溃）...
ping -n 6 127.0.0.1 >nul
goto dev_loop

:after_server
echo.

echo  服务已停止。重新双击 启动.bat 即可再次使用。

pause


:collect_pid
if "%~1"=="%WS_PIDS%" goto :eof
echo %WS_PIDS%| findstr /C:"\<%~1\>" >nul 2>nul
if not errorlevel 1 goto :eof
if defined WS_PIDS (set "WS_PIDS=%WS_PIDS% %~1") else set "WS_PIDS=%~1"
goto :eof
