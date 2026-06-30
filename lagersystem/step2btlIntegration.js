const fs = require('fs');
const path = require('path');
const { parseStep, writeBTL } = require('../step2btl/lib');

function convertStepTextToBtl(stepText, filename = 'model.step') {
  const part = parseStep(stepText, path.basename(filename));
  const btlText = writeBTL(part);
  return btlText;
}

module.exports = { convertStepTextToBtl };
