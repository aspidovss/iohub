# Тот же опыт, но рукоятки две: пишет одна, читает другая — как устроено в приложении.
$ErrorActionPreference = 'Stop'

$source = @"
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class TwoHid
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

    static timeouts Wait(int ms)
    {
        var t = new timeouts
        {
            ReadIntervalTimeout = 0xFFFFFFFF,
            ReadTotalTimeoutMultiplier = 0xFFFFFFFF,
            ReadTotalTimeoutConstant = (uint)ms,
            WriteTotalTimeoutMultiplier = 0,
            WriteTotalTimeoutConstant = 1000
        };
        return t;
    }

    public static int Run(string path, byte[] packet)
    {
        // Порядок как в приложении: сначала рукоятка для записи, потом для чтения.
        var writer = CreateFile(path, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (writer.IsInvalid) { Console.WriteLine("writer не открылся: " + Marshal.GetLastWin32Error()); return 1; }
        var reader = CreateFile(path, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        if (reader.IsInvalid) { Console.WriteLine("reader не открылся: " + Marshal.GetLastWin32Error()); return 2; }
        Console.WriteLine("обе рукоятки открыты");

        var tw = Wait(1000); SetCommTimeouts(writer, ref tw);
        var tr = Wait(2000); SetCommTimeouts(reader, ref tr);
        HidD_FlushQueue(reader);
        HidD_FlushQueue(writer);

        uint done;
        bool ok = WriteFile(writer, packet, (uint)packet.Length, out done, IntPtr.Zero);
        Console.WriteLine("запись через writer: ok=" + ok + " байт=" + done);

        var buf = new byte[128];
        uint got;
        bool rd = ReadFile(reader, buf, (uint)buf.Length, out got, IntPtr.Zero);
        Console.WriteLine("чтение через reader: ok=" + rd + " байт=" + got);
        if (got == 0)
        {
            // Проверим, не пришёл ли ответ в рукоятку записи.
            uint got2;
            var b2 = new byte[128];
            ReadFile(writer, b2, (uint)b2.Length, out got2, IntPtr.Zero);
            Console.WriteLine("чтение через writer: байт=" + got2);
            writer.Close(); reader.Close();
            return 3;
        }
        var parts = new string[got];
        for (int i = 0; i < got; i++) parts[i] = buf[i].ToString("x2");
        Console.WriteLine("ответ: " + string.Join(" ", parts));
        writer.Close(); reader.Close();
        return 0;
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies System.Runtime

$devicePath = "\\?\HID#VID_05AC&PID_024F&MI_02#9&2c934e8a&0&0000#{4d1e55b2-f16f-11cf-88cb-001111000030}"
$packet = New-Object byte[] 65
$packet[0] = 0x00
$packet[1] = 0xAA; $packet[2] = 0x10; $packet[3] = 0x30
$packet[6] = 0x01
[TwoHid]::Run($devicePath, $packet)
