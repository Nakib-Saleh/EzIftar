#!/bin/bash

# ============================================
# EzIftar Load Test Script
# Tests all microservices under load
# ============================================

set -e

BASE_URL="${BASE_URL:-http://localhost:8080}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:3000}"
CONCURRENT="${CONCURRENT:-10}"
REQUESTS="${REQUESTS:-100}"
TOKEN=""
ITEM_ID=""

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}   EzIftar Load Test Suite                  ${NC}"
echo -e "${BLUE}============================================${NC}"
echo -e "Gateway:  ${BASE_URL}"
echo -e "Identity: ${IDENTITY_URL}"
echo -e "Concurrent: ${CONCURRENT}"
echo -e "Requests:   ${REQUESTS}"
echo ""

# ============================================
# Check if services are alive
# ============================================
check_health() {
    echo -e "${YELLOW}[1/8] Checking service health...${NC}"

    services=("identity-provider:${IDENTITY_URL}/health" "order-gateway:${BASE_URL}/health")
    for svc in "${services[@]}"; do
        name="${svc%%:*}"
        url="${svc#*:}"
        status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
        if [ "$status" = "200" ]; then
            echo -e "  ${GREEN}✓${NC} $name: UP"
        else
            echo -e "  ${RED}✗${NC} $name: DOWN (HTTP $status)"
        fi
    done
    echo ""
}

# ============================================
# Register a test student
# ============================================
register_student() {
    echo -e "${YELLOW}[2/8] Registering test student...${NC}"

    STUDENT_ID="TEST$(date +%s)"
    RESPONSE=$(curl -s -X POST "${IDENTITY_URL}/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"studentId\": \"${STUDENT_ID}\", \"name\": \"Load Test User\", \"password\": \"password123\"}")

    TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

    if [ -n "$TOKEN" ]; then
        echo -e "  ${GREEN}✓${NC} Registered student: ${STUDENT_ID}"
        echo -e "  ${GREEN}✓${NC} Token acquired (${#TOKEN} chars)"
    else
        echo -e "  ${RED}✗${NC} Registration failed: $RESPONSE"
        # Try login instead
        RESPONSE=$(curl -s -X POST "${IDENTITY_URL}/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"studentId\": \"${STUDENT_ID}\", \"name\": \"Load Test User\", \"password\": \"password123\"}")
        TOKEN=$(echo "$RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    fi
    echo ""
}

# ============================================
# Seed stock items
# ============================================
seed_stock() {
    echo -e "${YELLOW}[3/8] Seeding stock items...${NC}"

    RESPONSE=$(curl -s -X POST "http://localhost:3002/seed")
    echo -e "  Seed: $RESPONSE"

    # Reset stock to initial levels so tests always start with full inventory
    RESET=$(curl -s -X POST "http://localhost:3002/reset")
    echo -e "  ${GREEN}✓${NC} Reset: $RESET"

    # Fetch real item UUID to use in order tests
    ITEMS=$(curl -s "${BASE_URL}/api/stock/items")
    ITEM_ID=$(echo "$ITEMS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "$ITEM_ID" ]; then
        echo -e "  ${GREEN}✓${NC} Using item ID: ${ITEM_ID}"
    else
        echo -e "  ${RED}✗${NC} Could not fetch item ID from stock service"
    fi
    echo ""
}

# ============================================
# Test rate limiting
# ============================================
test_rate_limit() {
    echo -e "${YELLOW}[4/8] Testing rate limiting (3 req/min)...${NC}"

    RATE_ID="RATETEST$(date +%s)"
    # Register the rate test user first
    curl -s -X POST "${IDENTITY_URL}/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"studentId\": \"${RATE_ID}\", \"name\": \"Rate Test\", \"password\": \"wrong\"}" > /dev/null 2>&1

    for i in $(seq 1 5); do
        status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${IDENTITY_URL}/auth/login" \
            -H "Content-Type: application/json" \
            -d "{\"studentId\": \"${RATE_ID}\", \"password\": \"wrongpassword\"}")
        echo -e "  Attempt $i: HTTP $status"
    done

    echo -e "  ${GREEN}✓${NC} Rate limiting test complete (expect 429 after 3 attempts)"
    echo ""
}

# ============================================
# Load test: Stock check
# ============================================
load_test_stock() {
    echo -e "${YELLOW}[5/8] Load testing stock endpoint...${NC}"

    SUCCESS=0
    FAIL=0
    TOTAL_TIME=0

    for i in $(seq 1 "$REQUESTS"); do
        START=$(date +%s%N)
        status=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/stock/items" \
            -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || echo "000")
        END=$(date +%s%N)
        ELAPSED=$(( (END - START) / 1000000 ))
        TOTAL_TIME=$((TOTAL_TIME + ELAPSED))

        if [ "$status" = "200" ]; then
            SUCCESS=$((SUCCESS + 1))
        else
            FAIL=$((FAIL + 1))
        fi
    done

    AVG=$((TOTAL_TIME / REQUESTS))
    echo -e "  Requests:  ${REQUESTS}"
    echo -e "  ${GREEN}Success:   ${SUCCESS}${NC}"
    echo -e "  ${RED}Failed:    ${FAIL}${NC}"
    echo -e "  Avg time:  ${AVG}ms"
    echo ""
}

# ============================================
# Load test: Place orders (concurrent)
# ============================================
load_test_orders() {
    echo -e "${YELLOW}[6/8] Load testing order placement (concurrent)...${NC}"

    TMPDIR=$(mktemp -d)
    ORDER_COUNT=50

    for i in $(seq 1 "$ORDER_COUNT"); do
        (
            status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/orders" \
                -H "Content-Type: application/json" \
                -H "Authorization: Bearer ${TOKEN}" \
                -d "{\"itemId\": \"${ITEM_ID}\", \"quantity\": 1}" 2>/dev/null || echo "000")
            echo "$status" > "${TMPDIR}/result_${i}"
        ) &

        # Limit concurrency
        if (( i % CONCURRENT == 0 )); then
            wait
        fi
    done
    wait

    SUCCESS=0
    FAIL=0
    for f in "${TMPDIR}"/result_*; do
        code=$(cat "$f")
        if [ "$code" = "200" ] || [ "$code" = "201" ]; then
            SUCCESS=$((SUCCESS + 1))
        else
            FAIL=$((FAIL + 1))
        fi
    done

    echo -e "  Orders:    ${ORDER_COUNT}"
    echo -e "  Concurrent: ${CONCURRENT}"
    echo -e "  ${GREEN}Success:   ${SUCCESS}${NC}"
    echo -e "  ${RED}Failed:    ${FAIL}${NC}"
    rm -rf "$TMPDIR"
    echo ""
}

# ============================================
# Test chaos: kill and recover stock service
# ============================================
test_chaos() {
    echo -e "${YELLOW}[7/8] Chaos test: killing stock-service...${NC}"

    # Stop the container via Docker (restart: always won't help during a docker stop)
    docker stop eziftar-stock-service-1 > /dev/null 2>&1

    sleep 3

    # Test order during outage
    status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/api/orders" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${TOKEN}" \
        -d "{\"itemId\": \"${ITEM_ID}\", \"quantity\": 1}" 2>/dev/null || echo "000")
    echo -e "  Order during outage: HTTP $status (expect 503)"

    # Bring it back up
    docker start eziftar-stock-service-1 > /dev/null 2>&1
    echo -e "  ${GREEN}✓${NC} Stock service restarted."
    echo ""
}

# ============================================
# Collect metrics
# ============================================
collect_metrics() {
    echo -e "${YELLOW}[8/8] Collecting gateway metrics...${NC}"

    STATS=$(curl -s "${BASE_URL}/api/stats/gateway" \
        -H "Authorization: Bearer ${TOKEN}" 2>/dev/null || echo "{}")

    echo -e "  $STATS"
    echo ""
}

# ============================================
# Run
# ============================================
check_health
register_student

if [ -z "$TOKEN" ]; then
    echo -e "${RED}Failed to get auth token. Aborting.${NC}"
    exit 1
fi

seed_stock
test_rate_limit
load_test_stock
load_test_orders
test_chaos
collect_metrics

echo -e "${BLUE}============================================${NC}"
echo -e "${GREEN}   Load test complete!                      ${NC}"
echo -e "${BLUE}============================================${NC}"
