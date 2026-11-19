# Проверка клавиатуры в обход приложения: пишет пакет в служебный интерфейс и читает ответ.
# Запуск: powershell -File probe_raw.ps1  (нужен режим FullLanguage, приложение должно быть закрыто)
$ErrorActionPreference = 'Stop'

$source = @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class RawHid
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sa,
        uint disp, uint flags, IntPtr template);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(SafeFileHandle h, byte[] buf, uint len, out uint written, IntPtr overlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(SafeFileHandle h, byte[] buf, uint len, out uint read, IntPtr overlapped);

    [DllImport("hid.dll", SetLastError = true)]
    static extern bool HidD_FlushQueue(SafeFileHandle h);

    [DllImport("hid.dll", SetLastError = true)]
    static extern bool HidD_GetAttributes(SafeFileHandle h, HIDD_ATTRIBUTES attrs);

    [StructLayout(LayoutKind.Sequential)]
    public class HIDD_ATTRIBUTES
    {
        public int Size;
        public ushort VendorID;
        public ushort ProductID;
        public ushort VersionNumber;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct timeouts
    {
        public uint ReadIntervalTimeout;
        public uint ReadTotalTimeoutMultiplier;
        public uint ReadTotalTimeoutConstant;
        public uint WriteTotalTimeoutMultiplier;
        public uint WriteTotalTimeoutConstant;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetCommTimeouts(SafeFileHandle h, ref timeouts t);

    public static int Run(string path, byte[] packet, int replyBytes, int waitMs)
    {
        var h = CreateFile(path, 0xC0000000, 0x00000003, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (h.IsInvalid)
        {
            Console.WriteLine("не открылось: " + Marshal.GetLastWin32Error());
            return 1;
        }
        using (h)
        {
            var a = new HIDD_ATTRIBUTES();
            a.Size = Marshal.SizeOf(typeof(HIDD_ATTRIBUTES));
            if (HidD_GetAttributes(h, a))
                Console.WriteLine(string.Format("открыто vid={0:x4} pid={1:x4} rev={2:x4}", a.VendorID, a.ProductID, a.VersionNumber));

            var t = new timeouts
            {
                ReadIntervalTimeout = 0xFFFFFFFF,
                ReadTotalTimeoutMultiplier = 0xFFFFFFFF,
                ReadTotalTimeoutConstant = (uint)waitMs,
                WriteTotalTimeoutMultiplier = 0,
                WriteTotalTimeoutConstant = 1000
            };
            SetCommTimeouts(h, ref t);
            HidD_FlushQueue(h);

            uint done;
            bool ok = WriteFile(h, packet, (uint)packet.Length, out done, IntPtr.Zero);
            Console.WriteLine("запись: ok=" + ok + " байт=" + done + " ошибка=" + Marshal.GetLastWin32Error());

            var buf = new byte[replyBytes];
            uint got;
            bool rd = ReadFile(h, buf, (uint)buf.Length, out got, IntPtr.Zero);
            if (!rd)
            {
                Console.WriteLine("чтение не удалось, ошибка=" + Marshal.GetLastWin32Error());
                return 2;
            }
            if (got == 0)
            {
                Console.WriteLine("ответа нет (0 байт за " + waitMs + " мс)");
                return 3;
            }
            var parts = new string[got];
            for (int i = 0; i < got; i++) parts[i] = buf[i].ToString("x2");
            Console.WriteLine("ответ " + got + " байт: " + string.Join(" ", parts));
            return 0;
        }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.Runtime

$devicePath = "\\?\HID#VID_05AC&PID_024F&MI_02#9&2c934e8a&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}"
# Тот же пакет, что отправляет приложение: id=0 + 64 байта кадра.
$packet = New-Object byte[] 65
$packet[0] = 0x00
$packet[1] = 0xAA; $packet[2] = 0x10; $packet[3] = 0x30
$packet[6] = 0x01
[RawHid]::Run($devicePath, $packet, 128, 2000)
"код завершения: $LASTEXITCODE"
