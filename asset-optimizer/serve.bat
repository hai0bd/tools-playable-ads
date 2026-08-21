@echo off
rem KHONG BAT BUOC — mo thang index.html la dung duoc roi.
rem Chay cai nay khi muon KEO CA THU MUC vao: Chrome chan doc thu muc
rem qua keo tha khi trang mo bang file://. Nut "Chon thu muc..." thi luon chay.
node "%~dp0serve.js" %1
pause
