function bad (message, status = 400) {
  return Object.assign(new Error(message), { status })
}

function stringField (value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw bad(`Invalid ${label}`)
  return value
}

function coordinates (input) {
  const { x, y, z } = input
  if (![x, y, z].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 30000000)) {
    throw bad('Expected finite x, y, z coordinates')
  }
  return [x, y, z]
}

function blockCoordinates (input) {
  const [x, y, z] = coordinates(input)
  if (![x, y, z].every(Number.isInteger)) throw bad('Expected integer block coordinates')
  return { x, y, z }
}

function materialName (value, label = 'material') {
  stringField(value, label, 64)
  if (!/^[a-z0-9_]+$/.test(value)) throw bad(`Invalid ${label}`)
  return value
}

// HTML form posts arrive as strings, so these parse before validating.

function numberField (value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`Invalid ${label}`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 30000000) throw bad(`Invalid ${label}`)
  return parsed
}

function integerField (value, label) {
  const parsed = numberField(value, label)
  if (!Number.isInteger(parsed)) throw bad(`Expected whole-number ${label}`)
  return parsed
}

module.exports = { bad, stringField, coordinates, blockCoordinates, materialName, numberField, integerField }
