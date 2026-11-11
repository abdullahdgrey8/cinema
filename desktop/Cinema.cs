using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

internal sealed partial class CinemaWindow : Form
{
    private const int CinemaPort = 3210;
    private const int InstalledCinemaPort = 3211;
    private const int SceneCompanionPort = 3212;
    private const string CompanionStartupIdentity = @"Local\CinemaDesktop.SceneCompanion.Startup";
    private static readonly Regex FolderPickerRequest = new Regex(
        @"\Acinema:pick-download-folder:([0-9a-f]{32})\z", RegexOptions.CultureInvariant);
    private readonly string origin;
    private readonly string root;
    private readonly string companionRoot;
    private readonly bool installed;
    private readonly Panel startup = new Panel { Dock = DockStyle.Fill };
    private readonly Label status = new Label { AutoSize = true };
    private readonly Button retry = new Button { Text = "Retry", AutoSize = true, Visible = false };
    private readonly WebView2 view = new WebView2 { Dock = DockStyle.Fill, Visible = false };
    private FormWindowState beforeFullscreen;
    private bool fullscreen;
    private bool loaded;
    private bool folderPickerPending;
    private bool folderPickerDocumentReady;
    private ulong folderPickerNavigationId;
    private long folderPickerDocumentRevision;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr window, int attribute, ref int value, int size);

    protected override void OnHandleCreated(EventArgs args)
    {
        base.OnHandleCreated(args);
        int dark = 1;
        if (DwmSetWindowAttribute(Handle, 20, ref dark, sizeof(int)) != 0)
            DwmSetWindowAttribute(Handle, 19, ref dark, sizeof(int));
    }

    [STAThread]
    private static void Main(string[] args)
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
#if CINEMA_QA
        if (RunFixture(args)) return;
#endif
        bool companionMode = args.Length == 3 && args[1] == "--scene-companion";
        bool installedMode = args.Length == 2 && args[1] == "--installed";
        string companionRoot = companionMode ? LocalAbsoluteDirectory(args[2]) : null;
        if ((args.Length != 1 && !installedMode && companionRoot == null) || !File.Exists(Path.Combine(args[0], "launch-cinema.mjs")))
        {
            MessageBox.Show(companionMode ? "Choose a Scene Preview profile directly under CinemaData in your Windows profile." :
                "Launch Cinema from its desktop shortcut.", companionMode ? "Cinema Scene Preview" : "Cinema");
            return;
        }

        string identity = installedMode ? @"Local\CinemaDesktop.Installed" : @"Local\CinemaDesktop";
        if (companionRoot != null)
        {
            using (var sha = SHA256.Create())
                identity += ".SceneCompanion." + BitConverter.ToString(sha.ComputeHash(
                    Encoding.UTF8.GetBytes(companionRoot.ToUpperInvariant()))).Replace("-", "");
        }
        bool first;
        using (var activation = new EventWaitHandle(false, EventResetMode.AutoReset, identity + ".Activate"))
        using (var instance = new Mutex(true, identity + ".Instance", out first))
        {
            if (!first) { activation.Set(); return; }
            using (var window = new CinemaWindow(args[0], activation, companionRoot, installedMode))
                Application.Run(window);
        }
    }

    private static string LocalAbsoluteDirectory(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length < 4 || !Char.IsLetter(value[0]) || value[1] != ':' ||
            (value[2] != '\\' && value[2] != '/') || value.IndexOf('"') >= 0) return null;
        try
        {
            string fullPath = Path.GetFullPath(value).TrimEnd('\\', '/');
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (fullPath.Length <= 3 || String.IsNullOrEmpty(userProfile) ||
                !String.Equals(Path.GetDirectoryName(fullPath), Path.Combine(userProfile, "CinemaData"), StringComparison.OrdinalIgnoreCase) ||
                !Regex.IsMatch(Path.GetFileName(fullPath), @"\ASceneCompanion(?:-qa-[a-zA-Z0-9][a-zA-Z0-9-]{0,63})?\z", RegexOptions.CultureInvariant))
                return null;
            return fullPath;
        }
        catch (ArgumentException) { return null; }
        catch (NotSupportedException) { return null; }
        catch (PathTooLongException) { return null; }
    }

    private CinemaWindow(string root, EventWaitHandle activation, string companionRoot = null, bool installed = false)
    {
        this.root = root;
        this.companionRoot = companionRoot;
        this.installed = installed;
        int port = installed ? InstalledCinemaPort : companionRoot == null ? CinemaPort : SceneCompanionPort;
        origin = "http://127.0.0.1:" + port;
        Text = companionRoot == null ? "Cinema" : "Cinema Scene Preview";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1240, 820);
        MinimumSize = new Size(420, 440);
        AutoScaleMode = AutoScaleMode.Dpi;
        BackColor = Color.FromArgb(11, 11, 15);
        ForeColor = Color.White;
        var messages = new FlowLayoutPanel {
            Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown,
            WrapContents = false, Padding = new Padding(28)
        };
        messages.Controls.Add(new Label { Text = Text, AutoSize = true, Font = new Font("Segoe UI", 28) });
        status.Font = new Font("Segoe UI", 11);
        status.MaximumSize = new Size(420, 0);
        messages.Controls.Add(status);
        retry.ForeColor = Color.Black;
        retry.Click += async (sender, args) => await StartAsync();
        messages.Controls.Add(retry);
        startup.Controls.Add(messages);
        Controls.Add(view);
        Controls.Add(startup);
        view.DefaultBackgroundColor = BackColor;
        Shown += async (sender, args) => await StartAsync();
        var activationTimer = new System.Windows.Forms.Timer { Interval = 250 };
        activationTimer.Tick += (sender, args) => {
            if (!activation.WaitOne(0)) return;
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
        };
        activationTimer.Start();
        FormClosed += (sender, args) => activationTimer.Dispose();
    }

    private async Task StartAsync()
    {
        retry.Visible = false;
        status.Text = installed ? "Starting Cinema and checking your search plugins…" :
            companionRoot == null ? "Starting Cinema and connecting to qBittorrent..." : "Opening your Scene Preview library...";
        try
        {
            Task service = Task.FromResult(true);
#if CINEMA_QA
            if (fixtureDirectory == null)
#endif
                service = companionRoot == null ? EnsureServiceAsync() : EnsureCompanionServiceAsync();
            if (installed || companionRoot != null)
            {
                await service;
                if (IsDisposed) return;
            }
            await Task.WhenAll(service, loaded ? Task.FromResult(true) : InitializeViewAsync());
            if (IsDisposed) return;
            view.CoreWebView2.Navigate(origin + "/");
        }
        catch (Exception error)
        {
            if (!IsDisposed) ShowFailure(Text + " could not open. " + error.Message);
        }
    }

    private async Task EnsureCompanionServiceAsync()
    {
        VerifyCompanionDirectory(companionRoot, true);
        using (var startupMutex = new Mutex(false, CompanionStartupIdentity))
        {
            var waited = Stopwatch.StartNew();
            bool ownsMutex = false;
            try
            {
                while (!ownsMutex)
                {
                    if (IsDisposed) return;
                    try { ownsMutex = startupMutex.WaitOne(0); }
                    catch (AbandonedMutexException) { ownsMutex = true; }
                    if (ownsMutex) break;
                    if (waited.ElapsedMilliseconds >= 30000)
                        throw new InvalidOperationException("Another Scene Preview library is starting. Try again in a moment.");
                    await Task.Delay(100);
                }
                VerifyCompanionDirectory(companionRoot, true);
                await EnsureServiceAsync();
            }
            finally
            {
                if (ownsMutex) startupMutex.ReleaseMutex();
            }
        }
    }

    private static void VerifyCompanionDirectory(string directory, bool requireProtected, bool allowMissing = false)
    {
        const string message = "Cinema Scene Preview could not verify its private profile folder.";
        FileAttributes attributes;
        try { attributes = File.GetAttributes(directory); }
        catch (FileNotFoundException) { if (allowMissing) return; throw new InvalidOperationException(message); }
        catch (DirectoryNotFoundException) { if (allowMissing) return; throw new InvalidOperationException(message); }
        catch (IOException) { throw new InvalidOperationException(message); }
        catch (UnauthorizedAccessException) { throw new InvalidOperationException(message); }
        catch (SecurityException) { throw new InvalidOperationException(message); }
        if ((attributes & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != FileAttributes.Directory)
            throw new InvalidOperationException(message);

        try
        {
            using (var identity = WindowsIdentity.GetCurrent())
            {
                var user = identity.User;
                var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
                var security = Directory.GetAccessControl(directory, AccessControlSections.Owner | AccessControlSections.Access);
                if (user == null || !user.Equals(security.GetOwner(typeof(SecurityIdentifier))) ||
                    (requireProtected && !security.AreAccessRulesProtected)) throw new InvalidOperationException(message);

                bool userAllowed = false;
                bool systemAllowed = false;
                foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
                {
                    if (rule.AccessControlType != AccessControlType.Allow) continue;
                    bool isUser = user.Equals(rule.IdentityReference);
                    if (!isUser && !system.Equals(rule.IdentityReference)) throw new InvalidOperationException(message);
                    if ((rule.PropagationFlags & PropagationFlags.InheritOnly) != 0 ||
                        (rule.FileSystemRights & FileSystemRights.FullControl) != FileSystemRights.FullControl) continue;
                    if (isUser) userAllowed = true;
                    else systemAllowed = true;
                }
                if (!userAllowed || !systemAllowed) throw new InvalidOperationException(message);
            }
        }
        catch (IOException) { throw new InvalidOperationException(message); }
        catch (UnauthorizedAccessException) { throw new InvalidOperationException(message); }
        catch (SecurityException) { throw new InvalidOperationException(message); }
    }

    private async Task EnsureServiceAsync()
    {
        string node = installed ? Path.Combine(root, "runtime", "node.exe") :
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        if (!File.Exists(node)) throw new InvalidOperationException(installed ?
            "The bundled runtime is missing. Run Cinema Setup again." : "Cinema needs Node.js 22 or later.");
        string arguments = "launch-cinema.mjs --services-only";
        if (installed) arguments += " --installed";
        if (companionRoot != null) arguments += " --scene-companion \"" + companionRoot + "\"";
        var start = new ProcessStartInfo(node, arguments) {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardError = true
        };
        using (var launcher = Process.Start(start))
        {
            string error = await launcher.StandardError.ReadToEndAsync();
            await Task.Run(() => launcher.WaitForExit());
            if (launcher.ExitCode != 0) throw new InvalidOperationException(error.Trim());
        }
    }

    private async Task InitializeViewAsync()
    {
        string profile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cinema", "WebView");
        if (installed)
        {
            string data = Environment.GetEnvironmentVariable("CINEMA_INSTALL_DATA_DIR");
            if (String.IsNullOrEmpty(data))
                data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Cinema", "Installed");
            profile = Path.Combine(Path.GetFullPath(data), "webview");
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", profile, EnvironmentVariableTarget.Process);
        }
        if (companionRoot != null)
        {
            string appData = Path.Combine(companionRoot, "app-data");
            profile = Path.Combine(appData, "webview");
            VerifyCompanionDirectory(companionRoot, true);
            VerifyCompanionDirectory(appData, false);
            VerifyCompanionDirectory(profile, false, true);
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", profile, EnvironmentVariableTarget.Process);
        }
#if CINEMA_QA
        if (fixtureDirectory != null) profile = Path.Combine(fixtureDirectory, "webview");
#endif
        var environment = await CoreWebView2Environment.CreateAsync(null, profile);
        if ((installed || companionRoot != null) && !String.Equals(profile, environment.UserDataFolder.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Cinema could not open its configured desktop profile.");
        await view.EnsureCoreWebView2Async(environment);
        var core = view.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.AreHostObjectsAllowed = false;
        bool folderPickerEnabled = companionRoot == null;
        core.Settings.IsWebMessageEnabled = folderPickerEnabled;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.NavigationStarting += (sender, args) => {
            args.Cancel = !IsLocal(args.Uri);
            if (folderPickerEnabled && !args.Cancel)
            {
                folderPickerNavigationId = args.NavigationId;
                folderPickerDocumentReady = false;
                folderPickerDocumentRevision++;
            }
        };
        core.FrameNavigationStarting += (sender, args) => { args.Cancel = !IsLocal(args.Uri); };
        if (folderPickerEnabled)
        {
            core.SourceChanged += (sender, args) => folderPickerDocumentRevision++;
            core.WebMessageReceived += (sender, args) => HandleFolderPickerRequest(core, args);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                "if(window===window.top&&location.origin==='" + origin + "'&&location.pathname==='/')" +
                "{Object.defineProperty(window,'cinemaDesktopFolderPicker',{value:true});}");
        }
        core.NewWindowRequested += (sender, args) => {
            args.Handled = true;
            Uri uri;
            if (args.IsUserInitiated && Uri.TryCreate(args.Uri, UriKind.Absolute, out uri) && uri.Scheme == "https")
            {
                try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
                catch (System.ComponentModel.Win32Exception) { }
            }
        };
        core.NavigationCompleted += (sender, args) => {
            if (folderPickerEnabled && args.NavigationId == folderPickerNavigationId)
                folderPickerDocumentReady = args.IsSuccess && IsLocal(core.Source, "/");
            if (!args.IsSuccess)
            {
                if (args.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled)
                    ShowFailure("Cinema's local service is unavailable. Try opening it again.");
                return;
            }
            startup.Visible = false;
            view.Visible = true;
            view.Focus();
#if CINEMA_QA
            if (fixtureDirectory != null) StartFixtureObservation();
#endif
        };
        core.ProcessFailed += (sender, args) => {
            if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                ShowFailure("Cinema's display stopped. Close and reopen the window.", false);
        };
        core.ContainsFullScreenElementChanged += (sender, args) => SetFullscreen(core.ContainsFullScreenElement);
        loaded = true;
    }

    private bool IsLocal(string value, string pathname = null)
    {
        Uri uri;
        return Uri.TryCreate(value, UriKind.Absolute, out uri) &&
            uri.GetLeftPart(UriPartial.Authority) == origin && String.IsNullOrEmpty(uri.UserInfo) &&
            (pathname == null || uri.AbsolutePath == pathname);
    }

    private void HandleFolderPickerRequest(CoreWebView2 core, CoreWebView2WebMessageReceivedEventArgs args)
    {
        if (folderPickerPending || IsDisposed || !IsHandleCreated || !folderPickerDocumentReady) return;
        string source = args.Source;
        if (!IsLocal(source, "/") || core.Source != source) return;

        string request;
        try { request = args.TryGetWebMessageAsString(); }
        catch (ArgumentException) { return; }
        if (request == null) return;
        Match match = FolderPickerRequest.Match(request);
        if (!match.Success) return;

        string requestId = match.Groups[1].Value;
        long revision = folderPickerDocumentRevision;
        folderPickerPending = true;
        // Show the modal after WebView2's message callback has returned.
        BeginInvoke((Action)(() => OpenFolderPicker(core, source, revision, requestId)));
    }

    private void OpenFolderPicker(CoreWebView2 core, string source, long revision, string requestId)
    {
        try
        {
            if (!IsFolderPickerDocument(core, source, revision)) return;
            string response = "cinema:download-folder:" + requestId + ":";
            string failure = "cinema:download-folder-error:" + requestId;
            try
            {
                using (var picker = new FolderBrowserDialog { Description = "Choose where Cinema saves new downloads." })
                {
                    if (picker.ShowDialog(this) == DialogResult.OK && Path.IsPathRooted(picker.SelectedPath))
                        response += picker.SelectedPath;
                }
            }
            catch (InvalidOperationException) { response = failure; }
            catch (ExternalException) { response = failure; }
            if (IsFolderPickerDocument(core, source, revision))
                core.PostWebMessageAsString(response);
        }
        catch (InvalidOperationException) { }
        catch (ExternalException) { }
        finally { folderPickerPending = false; }
    }

    private bool IsFolderPickerDocument(CoreWebView2 core, string source, long revision)
    {
        return !IsDisposed && folderPickerDocumentReady && folderPickerDocumentRevision == revision && core.Source == source;
    }

    private void ShowFailure(string message, bool canRetry = true)
    {
        view.Visible = false;
        startup.Visible = true;
        status.Text = message;
        retry.Visible = canRetry;
    }

    private void SetFullscreen(bool enable)
    {
        if (fullscreen == enable) return;
        fullscreen = enable;
        if (enable)
        {
            beforeFullscreen = WindowState;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Maximized;
        }
        else
        {
            FormBorderStyle = FormBorderStyle.Sizable;
            WindowState = beforeFullscreen;
        }
    }
}
