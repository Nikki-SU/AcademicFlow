#!/bin/bash
set -e

# AcademicFlow Worker 一键安装脚本
# 用法: curl -fsSL <URL>/install.sh | bash
# 或:   wget -qO- <URL>/install.sh | bash

echo ""
echo "=========================================="
echo "  AcademicFlow Worker 一键安装"
echo "=========================================="
echo ""

# ---------- 1. 检查环境 ----------
if [ "$(id -u)" -ne 0 ]; then
  echo "✗ 请用 root 用户运行（或加 sudo）"
  exit 1
fi

if ! command -v curl &> /dev/null; then
  echo "✗ 需要 curl，请先安装: apt install -y curl || yum install -y curl"
  exit 1
fi

# ---------- 2. 安装 Deno ----------
if command -v deno &> /dev/null; then
  echo "✓ Deno 已安装: $(deno --version | head -1)"
else
  echo "→ 正在安装 Deno..."
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="/root/.deno"
  export PATH="$DENO_INSTALL/bin:$PATH"
  if ! grep -q "DENO_INSTALL" /root/.bashrc; then
    echo 'export DENO_INSTALL="/root/.deno"' >> /root/.bashrc
    echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> /root/.bashrc
  fi
  echo "✓ Deno 安装完成"
fi

# ---------- 3. 克隆仓库 ----------
INSTALL_DIR="/opt/academicflow-worker"
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "→ 更新已有仓库..."
  cd "$INSTALL_DIR" && git pull --quiet
else
  echo "→ 克隆 AcademicFlow-Worker..."
  rm -rf "$INSTALL_DIR"
  git clone --quiet https://github.com/Nikki-SU/AcademicFlow-Worker.git "$INSTALL_DIR"
fi
echo "✓ 代码就绪: $INSTALL_DIR"

# ---------- 4. 创建 systemd 服务 ----------
echo "→ 配置系统服务..."
cat > /etc/systemd/system/academicflow-worker.service << 'UNIT'
[Unit]
Description=AcademicFlow Worker Proxy
After=network.target

[Service]
Type=simple
ExecStart=/root/.deno/bin/deno run --allow-net /opt/academicflow-worker/src/deno.js
WorkingDirectory=/opt/academicflow-worker
Restart=always
RestartSec=5
Environment=PATH=/root/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/root/bin

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable academicflow-worker
systemctl restart academicflow-worker
sleep 2

if systemctl is-active --quiet academicflow-worker; then
  echo "✓ 服务已启动（开机自启）"
else
  echo "✗ 服务启动失败，请检查: journalctl -u academicflow-worker -e"
  exit 1
fi

# ---------- 5. 获取公网 IP ----------
PUBLIC_IP=$(curl -s --connect-timeout 5 ifconfig.me 2>/dev/null || curl -s --connect-timeout 5 ip.sb 2>/dev/null || echo "")

# ---------- 6. 输出结果 ----------
echo ""
echo "=========================================="
echo "  ✅ 安装完成！"
echo "=========================================="
echo ""
if [ -n "$PUBLIC_IP" ]; then
  echo "  代理地址: http://$PUBLIC_IP:8000"
  echo ""
  echo "  把上面的地址填入 AcademicFlow → 设置 → MinerU 代理 URL"
else
  echo "  代理地址: http://你的服务器公网IP:8000"
fi
echo ""
echo "  验证: 浏览器打开 http://${PUBLIC_IP:-你的IP}:8000/__af_health"
echo "  应返回: {\"ok\":true,\"service\":\"academicflow-worker\"}"
echo ""
echo "  ⚠️  请确保阿里云安全组已开放 TCP 8000 端口"
echo "  ⚠️  如需停止: systemctl stop academicflow-worker"
echo "  ⚠️  如需重启: systemctl restart academicflow-worker"
echo "  ⚠️  查看日志: journalctl -u academicflow-worker -f"
echo ""
