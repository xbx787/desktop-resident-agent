# 用 PowerShell TTS 生成一段中文测试音频
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoiceByHints('zh-CN')
$synth.Rate = -1
$out = 'D:\DesktopPetProject\scripts\test-zh.wav'
$synth.SetOutputToWaveFile($out)
$synth.Speak('你好，这是一段测试语音，用来验证语音识别功能是否正常工作。')
$synth.Dispose()
Write-Host "生成音频: $out"
(Get-Item $out).Length
