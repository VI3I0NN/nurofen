# Remote help input agent.
#
# Nurofen starts this script with -File and writes one command per line to its
# stdin. The agent translates each line into a Win32 SendInput call. It exits
# when it reads "q" or when stdin closes, so closing the session cannot leave a
# stray process behind.
#
#   m x y          move the pointer, x and y are 0..65535 of the screen
#   b left 1       mouse button down (left, right, middle); 0 is button up
#   w -120         scroll wheel, 120 units per notch
#   k 65 1         keyboard virtual-key down; 0 is key up
#   u 1024         type a Unicode code point (layout-independent)
#   q              quit

$ErrorActionPreference = 'SilentlyContinue'

Add-Type -Language CSharp @'
using System;
using System.Runtime.InteropServices;

public static class NurofenInput {
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public MOUSEKEYBDHARDWAREINPUT data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct MOUSEKEYBDHARDWAREINPUT {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort vk;
        public ushort scan;
        public uint flags;
        public uint time;
        public IntPtr extra;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint MOVE = 0x0001;
    private const uint ABSOLUTE = 0x8000;
    private const uint LEFTDOWN = 0x0002;
    private const uint LEFTUP = 0x0004;
    private const uint RIGHTDOWN = 0x0008;
    private const uint RIGHTUP = 0x0010;
    private const uint MIDDLEDOWN = 0x0020;
    private const uint MIDDLEUP = 0x0040;
    private const uint WHEEL = 0x0800;
    private const uint KEYUP = 0x0002;
    private const uint UNICODE = 0x0004;

    private static void Send(INPUT input) {
        INPUT[] batch = new INPUT[1];
        batch[0] = input;
        SendInput(1, batch, Marshal.SizeOf(typeof(INPUT)));
    }

    private static INPUT Mouse(uint flags, int dx, int dy, uint data) {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.data.mouse.flags = flags;
        input.data.mouse.dx = dx;
        input.data.mouse.dy = dy;
        input.data.mouse.mouseData = data;
        return input;
    }

    private static INPUT Key(uint flags, ushort vk, ushort scan) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.data.keyboard.flags = flags;
        input.data.keyboard.vk = vk;
        input.data.keyboard.scan = scan;
        return input;
    }

    public static void Move(int x, int y) {
        Send(Mouse(MOVE | ABSOLUTE, x, y, 0));
    }

    public static void Button(string which, bool down) {
        uint flag;
        if (which == "right") flag = down ? RIGHTDOWN : RIGHTUP;
        else if (which == "middle") flag = down ? MIDDLEDOWN : MIDDLEUP;
        else flag = down ? LEFTDOWN : LEFTUP;
        Send(Mouse(flag, 0, 0, 0));
    }

    public static void Wheel(int delta) {
        unchecked {
            Send(Mouse(WHEEL, 0, 0, (uint)delta));
        }
    }

    public static void Key(int vk, bool down) {
        Send(Key(down ? 0 : KEYUP, (ushort)vk, 0));
    }

    public static void TypeUnicode(int code) {
        Send(Key(UNICODE, 0, (ushort)code));
        Send(Key(UNICODE | KEYUP, 0, (ushort)code));
    }
}
'@

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line.Length -eq 0) { continue }
    if ($line -eq 'q') { break }

    $parts = $line.Split(' ')
    switch ($parts[0]) {
        'm' {
            if ($parts.Length -ge 3) {
                [NurofenInput]::Move([int]$parts[1], [int]$parts[2])
            }
        }
        'b' {
            if ($parts.Length -ge 3) {
                [NurofenInput]::Button([string]$parts[1], $parts[2] -eq '1')
            }
        }
        'w' {
            if ($parts.Length -ge 2) {
                [NurofenInput]::Wheel([int]$parts[1])
            }
        }
        'k' {
            if ($parts.Length -ge 3) {
                [NurofenInput]::Key([int]$parts[1], $parts[2] -eq '1')
            }
        }
        'u' {
            if ($parts.Length -ge 2) {
                [NurofenInput]::TypeUnicode([int]$parts[1])
            }
        }
    }
}
