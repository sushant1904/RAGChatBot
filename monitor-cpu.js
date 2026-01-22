#!/usr/bin/env node

/**
 * CPU Monitoring Utility for RAG Agent
 * Run this alongside your server to monitor CPU usage
 */

const os = require('os');
const pidusage = require('pidusage');

const MONITOR_INTERVAL = 2000; // 2 seconds

function formatBytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function getCPUInfo() {
  const cpus = os.cpus();
  return {
    cores: cpus.length,
    model: cpus[0].model,
    speed: cpus[0].speed + ' MHz'
  };
}

async function monitorProcess(pid) {
  try {
    const stats = await pidusage(pid);
    const cpuInfo = getCPUInfo();
    
    console.clear();
    console.log('='.repeat(60));
    console.log('🔍 RAG Agent CPU Monitor');
    console.log('='.repeat(60));
    console.log(`\n📊 Process Stats (PID: ${pid}):`);
    console.log(`   CPU Usage: ${stats.cpu.toFixed(2)}%`);
    console.log(`   Memory: ${formatBytes(stats.memory)}`);
    console.log(`   Uptime: ${(stats.elapsed / 1000).toFixed(0)}s`);
    console.log(`\n💻 System Info:`);
    console.log(`   CPU Cores: ${cpuInfo.cores}`);
    console.log(`   CPU Model: ${cpuInfo.model}`);
    console.log(`   CPU Speed: ${cpuInfo.speed}`);
    console.log(`   System Load: ${os.loadavg().map(l => l.toFixed(2)).join(', ')}`);
    console.log(`   Free Memory: ${formatBytes(os.freemem())}`);
    console.log(`   Total Memory: ${formatBytes(os.totalmem())}`);
    console.log(`\n⏱️  Update interval: ${MONITOR_INTERVAL}ms`);
    console.log('   Press Ctrl+C to stop');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('Error monitoring process:', error.message);
  }
}

// Get server PID from command line or find it
const serverPid = process.argv[2];

if (!serverPid) {
  console.log('Usage: node monitor-cpu.js <server-pid>');
  console.log('\nTo find your server PID:');
  console.log('  - Check the terminal where you ran "npm start"');
  console.log('  - Or run: ps aux | grep "node.*server"');
  console.log('  - Or run: lsof -ti:3000 (for port 3000)');
  process.exit(1);
}

console.log(`Starting CPU monitor for PID ${serverPid}...`);
console.log('Press Ctrl+C to stop\n');

// Monitor every 2 seconds
const interval = setInterval(() => {
  monitorProcess(serverPid);
}, MONITOR_INTERVAL);

// Initial display
monitorProcess(serverPid);

// Cleanup on exit
process.on('SIGINT', () => {
  clearInterval(interval);
  console.log('\n\nMonitoring stopped.');
  process.exit(0);
});
