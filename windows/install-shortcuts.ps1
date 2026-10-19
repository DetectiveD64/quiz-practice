[CmdletBinding()]
param([switch] $Describe)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$appRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$executable=Join-Path $appRoot 'QuizPractice.exe'
$paths=@((Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'Quiz Practice.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'Quiz Practice.lnk'))
if($Describe){[ordered]@{shortcuts=$paths;target=$executable;startsAtLogin=$false}|ConvertTo-Json -Depth 3;exit 0}
if(-not(Test-Path -LiteralPath $executable -PathType Leaf)){throw 'QuizPractice.exe is missing.'}
$shell=New-Object -ComObject WScript.Shell
foreach($file in $paths){
    $link=$shell.CreateShortcut($file)
    if((Test-Path -LiteralPath $file -PathType Leaf) -and ($link.TargetPath -ine $executable -or -not[string]::IsNullOrEmpty($link.Arguments))){throw 'Another shortcut already uses the Quiz Practice name.'}
    $link.TargetPath=$executable;$link.Arguments='';$link.WorkingDirectory=$appRoot
    $link.Description='Quiz bowl questions, spoken practice, and statistics'
    $link.WindowStyle=1;$link.IconLocation=$executable+',0';$link.Save()
}
Write-Output 'Quiz Practice is available on the desktop and in the Start menu.'
