[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string] $SdkRoot,
    [Parameter(Mandatory=$true)][string] $AppRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$sdk = [IO.Path]::GetFullPath($SdkRoot)
$app = [IO.Path]::GetFullPath($AppRoot)
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'QuizPracticeDesktop.cs'
$core = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.Core.dll'
$forms = Join-Path $sdk 'lib\net462\Microsoft.Web.WebView2.WinForms.dll'
$loader = Join-Path $sdk 'runtimes\win-x64\native\WebView2Loader.dll'
foreach ($required in @($compiler,$source,$core,$forms,$loader,(Join-Path $app 'assets\app.ico'))) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw ('Missing build input: ' + $required) }
}
$output = Join-Path $app 'QuizPractice.exe'
if (Get-Process -Name QuizPractice -ErrorAction SilentlyContinue | Where-Object { $_.Path -ieq $output }) {
    throw 'Close this QuizPractice desktop window before rebuilding it.'
}
$arguments = @('/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output',
    ('/out:' + $output),('/win32icon:' + (Join-Path $app 'assets\app.ico')),
    ('/win32manifest:' + (Join-Path $PSScriptRoot 'QuizPractice.desktop.manifest')),
    '/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll',
    ('/reference:' + (Join-Path $env:SystemRoot 'Microsoft.NET\assembly\GAC_MSIL\System.Speech\v4.0_4.0.0.0__31bf3856ad364e35\System.Speech.dll')),'/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll',
    ('/reference:' + $core),('/reference:' + $forms),$source)
& $compiler @arguments
if ($LASTEXITCODE -ne 0) { throw 'QuizPractice desktop compilation failed.' }
Copy-Item -LiteralPath $core -Destination $app -Force
Copy-Item -LiteralPath $forms -Destination $app -Force
Copy-Item -LiteralPath $loader -Destination $app -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'QuizPractice.exe.config') -Destination $app -Force
$notices = Join-Path $app 'licenses\WebView2'
[IO.Directory]::CreateDirectory($notices) | Out-Null
foreach ($name in @('LICENSE.txt','NOTICE.txt')) { Copy-Item -LiteralPath (Join-Path $sdk $name) -Destination $notices -Force }
Get-Item -LiteralPath $output | Select-Object FullName,Length,@{Name='Version';Expression={$_.VersionInfo.FileVersion}}
