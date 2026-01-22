#!/bin/bash

# Simple CPU monitoring script for RAG Agent
# Usage: ./monitor-cpu.sh [port]

PORT=${1:-3000}
API_URL="http://localhost:${PORT}/api/cpu-usage"

echo "🔍 Monitoring RAG Agent CPU Usage"
echo "API Endpoint: ${API_URL}"
echo "Press Ctrl+C to stop"
echo ""

while true; do
  clear
  echo "============================================================"
  echo "🔍 RAG Agent CPU Monitor - $(date '+%Y-%m-%d %H:%M:%S')"
  echo "============================================================"
  
  if curl -s "${API_URL}" > /tmp/cpu_stats.json 2>/dev/null; then
    # Parse and display JSON (requires jq or use node/python)
    if command -v jq &> /dev/null; then
      cat /tmp/cpu_stats.json | jq '.'
    else
      # Fallback: use node to pretty print
      node -e "
        const data = require('/tmp/cpu_stats.json');
        console.log('\n📊 CPU Stats:');
        console.log('   Usage:', data.cpu.usage + '%');
        console.log('   Cores:', data.cpu.cores);
        console.log('   Model:', data.cpu.model);
        console.log('   Load Avg:', data.cpu.loadAverage.map(l => l.toFixed(2)).join(', '));
        console.log('\n💾 Memory Stats:');
        console.log('   Heap Used:', data.memory.used + ' MB');
        console.log('   Heap Total:', data.memory.total + ' MB');
        console.log('   RSS:', data.memory.rss + ' MB');
        console.log('\n🖥️  System:');
        console.log('   Free Memory:', data.system.freeMemory + ' MB');
        console.log('   Total Memory:', data.system.totalMemory + ' MB');
        console.log('   Uptime:', Math.round(data.system.uptime) + 's');
      "
    fi
  else
    echo "❌ Could not connect to server at ${API_URL}"
    echo "   Make sure the server is running on port ${PORT}"
  fi
  
  echo ""
  echo "============================================================"
  sleep 2
done
