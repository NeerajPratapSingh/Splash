@echo off
echo === Splash env check === > check-env.txt
echo [node] >> check-env.txt
node -v >> check-env.txt 2>&1
echo [npm] >> check-env.txt
call npm -v >> check-env.txt 2>&1
echo [rustc] >> check-env.txt
rustc --version >> check-env.txt 2>&1
echo [cargo] >> check-env.txt
cargo --version >> check-env.txt 2>&1
echo [cl-msvc] >> check-env.txt
where cl >> check-env.txt 2>&1
echo [webview2] >> check-env.txt
reg query "HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" /v pv >> check-env.txt 2>&1
echo [done] >> check-env.txt
