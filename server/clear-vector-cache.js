#!/usr/bin/env node
/**
 * Manual script to clear the entire vector cache
 * Run: node clear-vector-cache.js
 */

const { purgeEntireVectorCache } = require('./utils/files');

console.log('🗑️  Clearing vector cache...');
try {
  purgeEntireVectorCache();
  console.log('✅ Vector cache cleared successfully!');
  console.log('📝 All documents will be re-embedded when added to workspaces.');
} catch (error) {
  console.error('❌ Error clearing vector cache:', error);
  process.exit(1);
}
