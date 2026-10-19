using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using System.Reflection;
using System.Speech.Synthesis;
using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Media;
using System.Text;
using System.Text.RegularExpressions;

[assembly: AssemblyTitle("QuizPractice")]
[assembly: AssemblyDescription("Minimal spoken quiz bowl practice")]
[assembly: AssemblyProduct("QuizPractice")]
[assembly: AssemblyVersion("1.2.0.0")]
[assembly: AssemblyFileVersion("1.2.0.0")]

internal static class Program
{
    internal const string Origin = "http://127.0.0.1:43877";
    internal static readonly string Root = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
    internal static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private const string InstanceName = "Local\\QuizPractice.Desktop.43877";

    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test") return SelfTest(args);
        if (args.Length != 0) return 2;
        bool first;
        using (Mutex mutex = new Mutex(true, InstanceName, out first))
        using (EventWaitHandle focus = new EventWaitHandle(false, EventResetMode.AutoReset, InstanceName + ".Focus"))
        {
            if (!first) { focus.Set(); return 0; }
            try
            {
                EnableDpi();
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (PhotonWindow window = new PhotonWindow(focus)) Application.Run(window);
            }
            catch (Exception error) { Log(error); MessageBox.Show(error.Message, "QuizPractice", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
            finally { mutex.ReleaseMutex(); }
        }
        return 0;
    }

    internal static void Log(Exception error)
    {
        try { Directory.CreateDirectory(Path.Combine(Root, "logs")); File.AppendAllText(Path.Combine(Root, "logs/desktop.log"), DateTime.UtcNow.ToString("o") + " " + error.ToString() + Environment.NewLine); }
        catch { }
    }

    internal static List<string> MissingFiles()
    {
        string[] files = { "package.json", "src/server.mjs", "runtime/node.exe", "public/index.html", "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };
        List<string> missing = new List<string>();
        foreach (string file in files) if (!File.Exists(Path.Combine(Root, file))) missing.Add(file);
        if (missing.Count == 0)
        {
            try
            {
                Dictionary<string, object> manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(Root, "package.json")));
                if (!manifest.ContainsKey("name") || Convert.ToString(manifest["name"]) != "quiz-practice") missing.Add("package.json: wrong app identity");
            }
            catch { missing.Add("package.json: unreadable app identity"); }
        }
        return missing;
    }

    private static int SelfTest(string[] args)
    {
        if (args.Length != 2 || !Path.IsPathRooted(args[1])) return 2;
        try
        {
            List<string> missing = MissingFiles();
            string version = null, runtimeError = null;
            try { version = CoreWebView2Environment.GetAvailableBrowserVersionString(null); }
            catch (Exception error) { runtimeError = error.Message; }
            Dictionary<string, bool> checks = new Dictionary<string, bool>();
            checks["localApp"] = UrlRules.Local(Origin + "/");
            checks["localPostOrigin"] = UrlRules.Local(Origin + "/api/library");
            checks["rejectOtherPort"] = !UrlRules.Local("http://127.0.0.1:43876/");
            checks["rejectLocalCredentials"] = !UrlRules.Local("http://user@127.0.0.1:43877/");
            checks["archiveHttps"] = UrlRules.External("https://www.qbreader.org/");
            checks["archiveBareHttps"] = UrlRules.External("https://qbreader.org/");
            checks["rejectHttp"] = !UrlRules.External("http://example.com/");
            checks["rejectFile"] = !UrlRules.External("file:///C:/Windows/win.ini");
            checks["rejectCredentials"] = !UrlRules.External("https://user:pass@example.com/");
            checks["rejectLoopback"] = !UrlRules.External("https://127.0.0.1/") && !UrlRules.External("https://localhost/");
            checks["rejectScript"] = !UrlRules.External("javascript:alert(1)");
            checks["rejectBackslash"] = !UrlRules.External("https://example.com\\evil");
            checks["rejectLookalikes"] = !UrlRules.External("https://doi.org.example.com/paper") && !UrlRules.External("https://arxiv.org.evil/abs/1");
            checks["rejectOtherHttps"] = !UrlRules.External("https://example.com/");
            checks["rejectOtherHttpsPort"] = !UrlRules.External("https://doi.org:444/paper");
            checks["rejectCustomScheme"] = !UrlRules.External("ms-settings:privacy");
            checks["rejectHttpsLocal"] = !UrlRules.Local("https://127.0.0.1:43877/");
            checks["rejectOtherHost"] = !UrlRules.Local("http://example.com:43877/");
            bool rulesOk = true;
            foreach (bool passed in checks.Values) rulesOk = rulesOk && passed;
            Health health = Backend.Probe();
            bool ok = missing.Count == 0 && !String.IsNullOrEmpty(version) && rulesOk && health.State == "ready";
            Dictionary<string, object> report = new Dictionary<string, object>();
            report["ok"] = ok; report["appRoot"] = Root; report["requiredFiles"] = missing;
            report["runtimeVersion"] = version; report["runtimeError"] = runtimeError;
            using (SpeechSynthesizer voice = new SpeechSynthesizer()) report["installedVoices"] = voice.GetInstalledVoices().Count;
            report["health"] = health; report["urlRules"] = checks; report["checkedAt"] = DateTime.UtcNow.ToString("o");
            File.WriteAllText(Path.GetFullPath(args[1]), Json.Serialize(report));
            return ok ? 0 : 1;
        }
        catch { return 1; }
    }

    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    private static void EnableDpi()
    {
        try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch (EntryPointNotFoundException) { }
        try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
    }
}

internal static class UrlRules
{
    private static bool Parse(string value, out Uri uri)
    {
        uri = null;
        if (String.IsNullOrEmpty(value) || value.Length > 2080 || value.IndexOf('\\') >= 0) return false;
        foreach (char c in value) if (Char.IsWhiteSpace(c) || Char.IsControl(c)) return false;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) && String.IsNullOrEmpty(uri.UserInfo);
    }
    internal static bool Local(string value)
    {
        Uri uri;
        return Parse(value, out uri) && uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == 43877;
    }
    internal static bool External(string value)
    {
        Uri uri;
        if (!Parse(value, out uri) || uri.Scheme != "https" || uri.Port != 443 || uri.HostNameType != UriHostNameType.Dns) return false;
        string host = uri.DnsSafeHost.ToLowerInvariant();
        return host == "www.qbreader.org" || host == "qbreader.org";
    }
}

internal sealed class Health
{
    public string State { get; set; }
    public string Detail { get; set; }
    internal Health(string state, string detail) { State = state; Detail = detail; }
}

internal sealed class SpeechWord
{
    internal readonly double Time;
    internal readonly int Position;
    internal readonly int Count;
    internal SpeechWord(double time, int position, int count) { Time = time; Position = position; Count = count; }
}

internal sealed class SpeechPlan
{
    internal string AudioPath;
    internal double Duration;
    internal string Voice;
    internal int? NextPart;
    internal readonly List<SpeechWord> Words = new List<SpeechWord>();

    internal static bool IsAudioPath(string path)
    {
        return path != null && Regex.IsMatch(path, "\\A/api/speech/audio/[a-f0-9]{64}\\.wav\\z", RegexOptions.CultureInvariant);
    }

    private static object Field(Dictionary<string, object> value, string name)
    {
        object result;
        return value != null && value.TryGetValue(name, out result) ? result : null;
    }

    private static double Number(object value)
    {
        if (!(value is int) && !(value is long) && !(value is decimal) && !(value is double)) throw new InvalidDataException("Invalid speech timing.");
        double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        if (Double.IsNaN(number) || Double.IsInfinity(number)) throw new InvalidDataException("Invalid speech timing.");
        return number;
    }

    private static int Integer(object value)
    {
        double number = Number(value);
        if (number != Math.Truncate(number) || number < 0 || number > Int32.MaxValue) throw new InvalidDataException("Invalid speech text position.");
        return (int)number;
    }

    internal static bool IsTextRange(string text, int position, int count)
    {
        if (String.IsNullOrEmpty(text) || position < 0 || count < 1 || count > text.Length || position > text.Length - count) return false;
        if (position > 0 && Char.IsLowSurrogate(text[position]) && Char.IsHighSurrogate(text[position - 1])) return false;
        int end = position + count;
        if (end < text.Length && Char.IsLowSurrogate(text[end]) && Char.IsHighSurrogate(text[end - 1])) return false;
        return true;
    }

    internal static SpeechPlan Parse(string json, string text)
    {
        return ParsePart(json, text, 0);
    }

    internal static SpeechPlan ParsePart(string json, string text, int part)
    {
        if (part < 0 || part > 100) throw new InvalidDataException("Invalid speech part.");
        JavaScriptSerializer serializer = new JavaScriptSerializer();
        serializer.MaxJsonLength = 1024 * 1024;
        Dictionary<string, object> body = serializer.Deserialize<Dictionary<string, object>>(json);
        SpeechPlan plan = new SpeechPlan();
        plan.AudioPath = Field(body, "audioUrl") as string;
        if (!IsAudioPath(plan.AudioPath)) throw new InvalidDataException("Invalid local speech audio path.");
        plan.Duration = Number(Field(body, "duration"));
        if (plan.Duration <= 0 || plan.Duration > 1800) throw new InvalidDataException("Invalid speech duration.");
        plan.Voice = Field(body, "voice") as string;
        if (String.IsNullOrWhiteSpace(plan.Voice) || plan.Voice.Length > 100) throw new InvalidDataException("Invalid speech voice description.");
        object nextPart = Field(body, "nextPart");
        if (nextPart != null)
        {
            int next = Integer(nextPart);
            if (next > 100 || next <= part) throw new InvalidDataException("Invalid speech part progression.");
            plan.NextPart = next;
        }
        IEnumerable words = Field(body, "words") as IEnumerable;
        if (words == null || words is string) throw new InvalidDataException("Missing speech word timings.");
        double previousTime = -1;
        int previousPosition = -1;
        foreach (object value in words)
        {
            Dictionary<string, object> word = value as Dictionary<string, object>;
            double time = Number(Field(word, "time"));
            int position = Integer(Field(word, "position"));
            int count = Integer(Field(word, "count"));
            if (time < 0 || time > plan.Duration || time < previousTime || position < previousPosition
                || !IsTextRange(text, position, count) || plan.Words.Count >= 8000)
                throw new InvalidDataException("Invalid speech word timing or text position.");
            plan.Words.Add(new SpeechWord(time, position, count));
            previousTime = time; previousPosition = position;
        }
        if (plan.Words.Count == 0) throw new InvalidDataException("Missing speech word timings.");
        return plan;
    }
}

internal sealed class SpeechReceipt
{
    internal readonly string RequestId;
    internal readonly long Generation;
    internal readonly string Text;
    internal bool NeuralStarted;
    internal SpeechReceipt(string requestId, long generation, string text) { RequestId = requestId; Generation = generation; Text = text; }
    internal bool Matches(long generation, string requestId) { return Generation == generation && RequestId == requestId; }
}

internal sealed class SpeechAudioPart
{
    internal readonly SpeechPlan Plan;
    internal readonly byte[] Audio;
    internal SpeechAudioPart(SpeechPlan plan, byte[] audio) { Plan = plan; Audio = audio; }
}

internal sealed class Backend : IDisposable
{
    private Process owned;
    private bool disposed;
    internal static Health Probe()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.Origin + "/api/health");
            request.Method = "GET"; request.Timeout = 1500; request.ReadWriteTimeout = 1500; request.AllowAutoRedirect = false; request.Proxy = null;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
            {
                char[] buffer = new char[4097]; int count = 0, read;
                while (count < buffer.Length && (read = reader.Read(buffer, count, buffer.Length - count)) > 0) count += read;
                if (response.StatusCode != HttpStatusCode.OK || count > 4096) return new Health("conflict", "Unexpected response on QuizPractice's port.");
                Dictionary<string, object> body = Program.Json.Deserialize<Dictionary<string, object>>(new string(buffer, 0, count));
                if (body != null && body.ContainsKey("app") && Convert.ToString(body["app"]) == "quiz-practice" && body.ContainsKey("ok") && body["ok"] is bool && (bool)body["ok"])
                    return new Health("ready", "QuizPractice server identity verified.");
                return new Health("conflict", "Another service is using QuizPractice's port.");
            }
        }
        catch (WebException error)
        {
            Exception inner = error;
            while (inner != null)
            {
                SocketException socket = inner as SocketException;
                if (socket != null && socket.SocketErrorCode == SocketError.ConnectionRefused) return new Health("absent", "QuizPractice is not listening.");
                inner = inner.InnerException;
            }
            if (error.Response != null) { error.Response.Close(); return new Health("conflict", "Unexpected HTTP response on QuizPractice's port."); }
            // Windows may surface a refused first connection as an HTTP timeout.
            // An OS listener check distinguishes an unused port from a hung service.
            try
            {
                bool listening = false;
                foreach (IPEndPoint endpoint in System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
                    if (endpoint.Port == 43877) { listening = true; break; }
                if (!listening) return new Health("absent", "QuizPractice is not listening.");
            }
            catch { }
            return new Health("unreachable", "QuizPractice's local server did not respond.");
        }
        catch { return new Health("conflict", "The local server did not return QuizPractice's health identity."); }
    }

    internal async Task EnsureReady()
    {
        List<string> missing = Program.MissingFiles();
        if (missing.Count > 0) throw new InvalidOperationException("QuizPractice files are missing: " + String.Join(", ", missing.ToArray()));
        Health health = await Task.Run(() => Probe());
        if (disposed) throw new OperationCanceledException();
        if (health.State == "ready") return;
        if (health.State != "absent") throw new InvalidOperationException(health.Detail);
        // Recheck before starting our own worker; an existing supervisor may be starting it.
        health = await Task.Run(() => Probe());
        if (disposed) throw new OperationCanceledException();
        if (health.State == "ready") return;
        if (health.State != "absent") throw new InvalidOperationException(health.Detail);
        ProcessStartInfo info = new ProcessStartInfo(Path.Combine(Program.Root, "runtime/node.exe"), "\"" + Path.Combine(Program.Root, "src/server.mjs") + "\"");
        info.UseShellExecute = false; info.CreateNoWindow = true; info.WindowStyle = ProcessWindowStyle.Hidden; info.WorkingDirectory = Program.Root;
        info.EnvironmentVariables["QUIZ_PRACTICE_ROOT"] = Program.Root; info.EnvironmentVariables["QUIZ_PRACTICE_PORT"] = "43877";
        info.EnvironmentVariables["HOST"] = "127.0.0.1"; info.EnvironmentVariables["PORT"] = "43877"; info.EnvironmentVariables["NODE_ENV"] = "production";
        info.EnvironmentVariables.Remove("NODE_OPTIONS"); info.EnvironmentVariables.Remove("NODE_PATH");
        owned = Process.Start(info);
        if (owned == null) throw new InvalidOperationException("QuizPractice could not start its local server.");
        IntPtr retainedHandle = owned.Handle;
        DateTime deadline = DateTime.UtcNow.AddSeconds(20);
        while (DateTime.UtcNow < deadline)
        {
            health = await Task.Run(() => Probe());
            if (disposed) throw new OperationCanceledException();
            if (health.State == "ready") return;
            if (health.State == "conflict") throw new InvalidOperationException(health.Detail);
            if (owned.HasExited) throw new InvalidOperationException("QuizPractice's local server stopped before it was ready.");
            await Task.Delay(200);
        }
        throw new InvalidOperationException("QuizPractice's local server took too long to start. Please try opening the app again.");
    }

    public void Dispose()
    {
        disposed = true;
        if (owned == null) return;
        try { if (!owned.HasExited) owned.Kill(); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
        owned.Dispose(); owned = null;
    }
}

internal sealed class PhotonWindow : Form
{
    private readonly Backend backend = new Backend();
    private readonly EventWaitHandle focus;
    private readonly System.Windows.Forms.Timer focusTimer = new System.Windows.Forms.Timer();
    private readonly WebView2 view = new WebView2();
    private readonly Label status = new Label();
    private SpeechSynthesizer speech;
    private readonly ConcurrentDictionary<Prompt, SpeechReceipt> speechPrompts = new ConcurrentDictionary<Prompt, SpeechReceipt>();
    private readonly System.Windows.Forms.Timer speechTimer = new System.Windows.Forms.Timer();
    private readonly Stopwatch speechClock = new Stopwatch();
    private CancellationTokenSource speechCancellation;
    private long speechGeneration;
    private string activeSpeechRequest;
    private SoundPlayer neuralPlayer;
    private MemoryStream neuralStream;
    private SpeechPlan playingPlan;
    private SpeechReceipt playingReceipt;
    private int nextSpeechWord;
    private volatile bool closing;

    internal PhotonWindow(EventWaitHandle signal)
    {
        focus = signal; Text = "Quiz Practice"; StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1160, 800); MinimumSize = new Size(700, 560); BackColor = Color.FromArgb(250, 250, 248);
        string iconPath = Path.Combine(Program.Root, "assets/app.ico");
        if (File.Exists(iconPath)) Icon = new Icon(iconPath);
        view.Dock = DockStyle.Fill; view.Visible = false; Controls.Add(view);
        status.Dock = DockStyle.Fill; status.ForeColor = Color.FromArgb(40, 40, 40); status.BackColor = BackColor;
        status.Font = new Font("Segoe UI", 14); status.TextAlign = ContentAlignment.MiddleCenter; status.Text = "Opening QuizPractice…"; Controls.Add(status);
        focusTimer.Interval = 200;
        focusTimer.Tick += delegate { if (focus.WaitOne(0)) { if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Show(); Activate(); BringToFront(); } };
        focusTimer.Start();
        speechTimer.Interval = 20;
        speechTimer.Tick += delegate { EmitDueWords(); };
        Shown += async delegate { await InitializeBrowser(); };
    }

    private async Task InitializeBrowser()
    {
        try
        {
            await backend.EnsureReady();
            if (closing) return;
            string profile = Path.Combine(Program.Root, "data/desktop-profile");
            CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
            if (closing) return;
            await view.EnsureCoreWebView2Async(environment);
            if (closing) return;
            CoreWebView2 core = view.CoreWebView2;
            core.Settings.IsWebMessageEnabled = true; core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false; core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.WebMessageReceived += OnSpeechMessage;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e)
            {
                if (UrlRules.Local(e.Uri)) return;
                e.Cancel = true;
                if (e.IsUserInitiated) OpenExternal(e.Uri);
            };
            core.FrameNavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) { if (!UrlRules.Local(e.Uri)) e.Cancel = true; };
            core.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; if (e.IsUserInitiated) OpenExternal(e.Uri); };
            core.LaunchingExternalUriScheme += delegate(object sender, CoreWebView2LaunchingExternalUriSchemeEventArgs e) { e.Cancel = true; };
            core.DownloadStarting += delegate(object sender, CoreWebView2DownloadStartingEventArgs e) { e.Cancel = true; e.Handled = true; };
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) { e.State = CoreWebView2PermissionState.Deny; e.Handled = true; };
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                if (closing) return;
                if (!e.IsSuccess && e.WebErrorStatus == CoreWebView2WebErrorStatus.ConnectionAborted) return;
                if (e.IsSuccess) { status.Visible = false; view.Visible = true; view.BringToFront(); }
                else { status.Text = "QuizPractice could not load its local window. Close and reopen the app to try again."; status.Visible = true; status.BringToFront(); }
            };
            core.Navigate(Program.Origin + "/");
        }
        catch (Exception error) { Program.Log(error); if (!closing) status.Text = "QuizPractice could not open.\n\n" + error.Message; }
    }

    private async void OnSpeechMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (closing || !UrlRules.Local(e.Source)) return;
        try
        {
            string raw = e.WebMessageAsJson;
            if (raw == null || raw.Length > 65536) return;
            Dictionary<string, object> message = Program.Json.Deserialize<Dictionary<string, object>>(raw);
            object actionValue;
            if (message == null || !message.TryGetValue("action", out actionValue) || !(actionValue is string)) return;
            string action = (string)actionValue;
            if (action != "speak" && action != "stop") return;
            if (action == "stop") { StopSpeech(); return; }
            object textValue, requestValue;
            if (!message.TryGetValue("text", out textValue) || !(textValue is string)) return;
            if (!message.TryGetValue("requestId", out requestValue) || !(requestValue is string)) return;
            string text = (string)textValue;
            string requestId = (string)requestValue;
            if (String.IsNullOrWhiteSpace(text) || text.Length > 8000) return;
            if (String.IsNullOrWhiteSpace(requestId) || requestId.Length > 120) return;
            foreach (char value in requestId) if (Char.IsControl(value) || Char.IsWhiteSpace(value)) return;
            StopSpeech();
            SpeechReceipt receipt = new SpeechReceipt(requestId, speechGeneration, text);
            activeSpeechRequest = requestId;
            speechCancellation = new CancellationTokenSource();
            CancellationToken cancellation = speechCancellation.Token;
            try { await SpeakNeural(receipt, cancellation); }
            catch (Exception error)
            {
                if (!IsCurrentSpeech(receipt) || cancellation.IsCancellationRequested) return;
                Program.Log(error);
                ReleaseNeuralAudio();
                // Never restart the full question after a later chunk fails.
                if (receipt.NeuralStarted)
                {
                    EmitSpeech(receipt, "speech-error", null);
                    if (IsCurrentSpeech(receipt)) StopSpeech();
                    return;
                }
                try { SpeakFallback(receipt); }
                catch (Exception fallbackError)
                {
                    Program.Log(fallbackError);
                    EmitSpeech(receipt, "speech-error", null);
                    if (IsCurrentSpeech(receipt)) StopSpeech();
                }
            }
        }
        catch (Exception error)
        {
            Program.Log(error);
        }
    }

    private bool IsCurrentSpeech(SpeechReceipt receipt)
    {
        return receipt != null && !closing && !IsDisposed && receipt.Matches(speechGeneration, activeSpeechRequest);
    }

    private void EmitSpeech(SpeechReceipt receipt, string type, Dictionary<string, object> fields)
    {
        if (!IsCurrentSpeech(receipt) || view.CoreWebView2 == null || !UrlRules.Local(view.CoreWebView2.Source)) return;
        Dictionary<string, object> value = fields ?? new Dictionary<string, object>();
        value["type"] = type; value["requestId"] = receipt.RequestId;
        view.CoreWebView2.PostWebMessageAsJson(Program.Json.Serialize(value));
    }

    private void EmitOnUi(SpeechReceipt receipt, string type, Dictionary<string, object> fields)
    {
        if (closing || IsDisposed || !IsHandleCreated) return;
        try { BeginInvoke((Action)delegate {
            EmitSpeech(receipt, type, fields);
            if ((type == "speech-ended" || type == "speech-error") && IsCurrentSpeech(receipt)) activeSpeechRequest = null;
        }); }
        catch (InvalidOperationException) { }
    }

    private void StopSpeech()
    {
        Interlocked.Increment(ref speechGeneration);
        activeSpeechRequest = null;
        speechPrompts.Clear();
        CancellationTokenSource cancellation = speechCancellation;
        speechCancellation = null;
        if (cancellation != null) { cancellation.Cancel(); cancellation.Dispose(); }
        ReleaseNeuralAudio();
        if (speech != null) speech.SpeakAsyncCancelAll();
    }

    private void ReleaseNeuralAudio()
    {
        speechTimer.Stop(); speechClock.Stop();
        playingPlan = null; playingReceipt = null; nextSpeechWord = 0;
        SoundPlayer player = neuralPlayer; neuralPlayer = null;
        MemoryStream stream = neuralStream; neuralStream = null;
        if (player != null) { try { player.Stop(); } catch (InvalidOperationException) { } player.Dispose(); }
        if (stream != null) stream.Dispose();
    }

    private static async Task<byte[]> ReadLimited(Stream stream, int maximum, CancellationToken cancellation)
    {
        if (stream == null) throw new InvalidDataException("Local speech response was empty.");
        using (MemoryStream result = new MemoryStream())
        {
            byte[] buffer = new byte[32768]; int read;
            while ((read = await stream.ReadAsync(buffer, 0, buffer.Length, cancellation)) > 0)
            {
                if (result.Length + read > maximum) throw new InvalidDataException("Local speech response was too large.");
                result.Write(buffer, 0, read);
            }
            cancellation.ThrowIfCancellationRequested();
            return result.ToArray();
        }
    }

    private static async Task<byte[]> LocalSpeechRequest(string relativePath, byte[] body, string token, int maximum, CancellationToken cancellation)
    {
        if (relativePath != "/api/speech" && !SpeechPlan.IsAudioPath(relativePath)) throw new InvalidDataException("Invalid local speech request path.");
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.Origin + relativePath);
        request.Method = body == null ? "GET" : "POST";
        request.AllowAutoRedirect = false; request.Proxy = null; request.Timeout = 90000; request.ReadWriteTimeout = 90000;
        request.Headers["Origin"] = Program.Origin;
        if (body != null)
        {
            request.Headers["x-practice-token"] = token;
            request.ContentType = "application/json; charset=utf-8"; request.ContentLength = body.Length;
        }
        using (cancellation.Register(delegate { request.Abort(); }))
        {
            if (body != null)
            {
                using (Stream output = await request.GetRequestStreamAsync()) await output.WriteAsync(body, 0, body.Length, cancellation);
            }
            using (HttpWebResponse response = (HttpWebResponse)await request.GetResponseAsync())
            {
                if (response.StatusCode != HttpStatusCode.OK || !UrlRules.Local(response.ResponseUri.AbsoluteUri)
                    || response.ContentLength > maximum) throw new InvalidDataException("Invalid local speech response.");
                string expectedType = body == null ? "audio/wav" : "application/json";
                string contentType = (response.ContentType ?? "").Split(';')[0].Trim();
                if (!String.Equals(contentType, expectedType, StringComparison.OrdinalIgnoreCase)
                    && !(body == null && String.Equals(contentType, "audio/x-wav", StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidDataException("Unexpected local speech response format.");
                using (Stream input = response.GetResponseStream()) return await ReadLimited(input, maximum, cancellation);
            }
        }
    }

    private static async Task<SpeechAudioPart> FetchNeuralPart(SpeechReceipt receipt, int part, string token, CancellationToken cancellation)
    {
        using (CancellationTokenSource deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
        {
            deadline.CancelAfter(90000);
            byte[] body = Encoding.UTF8.GetBytes(Program.Json.Serialize(new Dictionary<string, object> { { "text", receipt.Text }, { "part", part } }));
            byte[] response = await LocalSpeechRequest("/api/speech", body, token, 1024 * 1024, deadline.Token);
            SpeechPlan plan = SpeechPlan.ParsePart(Encoding.UTF8.GetString(response), receipt.Text, part);
            byte[] wav = await LocalSpeechRequest(plan.AudioPath, null, null, 15 * 1024 * 1024, deadline.Token);
            deadline.Token.ThrowIfCancellationRequested();
            if (wav.Length < 44 || Encoding.ASCII.GetString(wav, 0, 4) != "RIFF" || Encoding.ASCII.GetString(wav, 8, 4) != "WAVE")
                throw new InvalidDataException("The local voice did not return WAV audio.");
            // Prefetch owns only immutable bytes and a plan. It cannot replace,
            // start, or dispose the UI thread's current audio player.
            return new SpeechAudioPart(plan, wav);
        }
    }

    private static void ObservePrefetchFailure(Task task)
    {
        task.ContinueWith(failed => { AggregateException observed = failed.Exception; }, CancellationToken.None, TaskContinuationOptions.OnlyOnFaulted, TaskScheduler.Default);
    }

    private async Task SpeakNeural(SpeechReceipt receipt, CancellationToken cancellation)
    {
        string token = File.ReadAllText(Path.Combine(Program.Root, "data/csrf-token")).Trim();
        if (!Regex.IsMatch(token, "\\A[a-f0-9]{64}\\z", RegexOptions.CultureInvariant)) throw new InvalidDataException("The local app session is unavailable.");
        using (CancellationTokenSource run = CancellationTokenSource.CreateLinkedTokenSource(cancellation))
        {
            Task<SpeechAudioPart> prefetch = null;
            try
            {
                SpeechAudioPart current = await FetchNeuralPart(receipt, 0, token, run.Token);
                int previousEnd = -1;
                while (true)
                {
                    run.Token.ThrowIfCancellationRequested();
                    if (!IsCurrentSpeech(receipt)) return;
                    SpeechPlan plan = current.Plan;
                    if (plan.Words[0].Position < previousEnd) throw new InvalidDataException("Speech parts overlap their original text.");
                    SpeechWord last = plan.Words[plan.Words.Count - 1];
                    previousEnd = last.Position + last.Count;
                    neuralStream = new MemoryStream(current.Audio, false);
                    neuralPlayer = new SoundPlayer(neuralStream);
                    neuralPlayer.Load();
                    playingPlan = plan; playingReceipt = receipt; nextSpeechWord = 0;
                    // UI ownership prevents StopSpeech from racing an audio start.
                    neuralPlayer.Play();
                    speechClock.Restart(); speechTimer.Start();
                    if (!receipt.NeuralStarted)
                    {
                        receipt.NeuralStarted = true;
                        EmitSpeech(receipt, "speech-started", new Dictionary<string, object> { { "voice", plan.Voice }, { "duration", plan.Duration }, { "fallback", false } });
                    }
                    EmitDueWords();
                    prefetch = plan.NextPart.HasValue ? FetchNeuralPart(receipt, plan.NextPart.Value, token, run.Token) : null;
                    if (prefetch != null)
                    {
                        // A stop can finish before the pending request faults;
                        // observe that fault even when no caller will await it.
                        ObservePrefetchFailure(prefetch);
                    }
                    await Task.Delay(TimeSpan.FromSeconds(plan.Duration + 0.05), run.Token);
                    if (!IsCurrentSpeech(receipt)) return;
                    EmitDueWords();
                    ReleaseNeuralAudio();
                    if (prefetch == null)
                    {
                        EmitSpeech(receipt, "speech-ended", null);
                        activeSpeechRequest = null;
                        return;
                    }
                    current = await prefetch;
                    prefetch = null;
                }
            }
            finally
            {
                // Includes the first request, current wait, audio download, and
                // every prefetched part, even on replay or a later-part failure.
                run.Cancel();
            }
        }
    }

    private void EmitDueWords()
    {
        SpeechPlan plan = playingPlan;
        SpeechReceipt receipt = playingReceipt;
        if (plan == null || !IsCurrentSpeech(receipt)) return;
        double elapsed = speechClock.Elapsed.TotalSeconds;
        while (nextSpeechWord < plan.Words.Count && plan.Words[nextSpeechWord].Time <= elapsed)
        {
            SpeechWord word = plan.Words[nextSpeechWord++];
            EmitSpeech(receipt, "speech-word", new Dictionary<string, object> { { "position", word.Position }, { "count", word.Count } });
        }
    }

    private void SpeakFallback(SpeechReceipt receipt)
    {
        if (!IsCurrentSpeech(receipt)) return;
        if (speech == null)
        {
            speech = new SpeechSynthesizer(); speech.SetOutputToDefaultAudioDevice(); speech.Rate = -1;
            foreach (string name in new string[] { "Microsoft Zira", "Microsoft Zira Desktop" })
            {
                bool selected = false;
                foreach (InstalledVoice installed in speech.GetInstalledVoices())
                    if (installed.Enabled && installed.VoiceInfo.Name == name) { speech.SelectVoice(name); selected = true; break; }
                if (selected) break;
            }
            speech.SpeakProgress += delegate(object sender, SpeakProgressEventArgs progress)
            {
                SpeechReceipt original;
                if (!speechPrompts.TryGetValue(progress.Prompt, out original)
                    || !SpeechPlan.IsTextRange(original.Text, progress.CharacterPosition, progress.CharacterCount)) return;
                EmitOnUi(original, "speech-word", new Dictionary<string, object> { { "position", progress.CharacterPosition }, { "count", progress.CharacterCount } });
            };
            speech.SpeakCompleted += delegate(object sender, SpeakCompletedEventArgs completed)
            {
                SpeechReceipt original;
                if (!speechPrompts.TryRemove(completed.Prompt, out original) || completed.Cancelled || closing) return;
                if (completed.Error != null) Program.Log(completed.Error);
                EmitOnUi(original, completed.Error == null ? "speech-ended" : "speech-error", null);
            };
        }
        Prompt prompt = new Prompt(receipt.Text, SynthesisTextFormat.Text);
        speechPrompts[prompt] = receipt;
        EmitSpeech(receipt, "speech-started", new Dictionary<string, object> { { "voice", speech.Voice.Name }, { "fallback", true } });
        speech.SpeakAsync(prompt);
    }

    private static void OpenExternal(string url)
    {
        if (!UrlRules.External(url)) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show("The link could not be opened.\n" + error.Message, "QuizPractice", MessageBoxButtons.OK, MessageBoxIcon.Information); }
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        closing = true; StopSpeech(); focusTimer.Stop(); focusTimer.Dispose(); speechTimer.Dispose();
        if (speech != null) speech.Dispose();
        view.Dispose(); backend.Dispose();
        base.OnFormClosed(e);
    }
}
