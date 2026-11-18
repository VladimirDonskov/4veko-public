/** Sample configuration shown in the Configurator and used by tests. */
export const SAMPLE_CONFIGURATION = `# Sample 4VEKO configuration: equipment rental and counter sales.
# Catalogs hold reference data, documents record events, registers keep balances.

catalog Equipment
  field name: Text required
  field serial: Text
  field dailyRate: Money required
end

# How many units of each piece of equipment are out with customers.
# "nonnegative" refuses any posting that would return more than went out.
register EquipmentOut nonnegative
  dimension equipment: Equipment
  resource units: Quantity
end

register RentalRevenue
  dimension customer: Customer
  resource amount: Money
end

function lineAmount(days, rate)
  return round(days * rate, 2)
end

# A rental paid at the counter: revenue now, equipment goes out.
document Rental
  field customer: Customer required
  field note: Text
  table lines
    equipment: Equipment required
    days: Quantity required
    rate: Money
    amount: Money
  end
  field total: Money

  on write
    if len(lines) == 0
      fail "Add at least one piece of equipment."
    end
    let sum = 0
    for line in lines
      if line.equipment == null or line.days == null
        fail "Every line needs equipment and a number of days."
      end
      if line.days <= 0
        fail "Days must be more than zero."
      end
      if line.rate == null
        line.rate = line.equipment.dailyRate
      end
      line.amount = lineAmount(line.days, line.rate)
      sum = sum + line.amount
    end
    total = sum
  end

  on post
    for line in lines
      EquipmentOut.add(equipment: line.equipment, units: 1)
    end
    RentalRevenue.add(customer: customer, amount: total)
    ledger.post(debit: accounts.undeposited, credit: accounts.services,
                amount: total, party: customer, memo: "Rental " + number)
    message("Rental " + number + " posted for " + text(total))
  end
end

# Equipment coming back from a rental.
document EquipmentReturn
  field rental: Rental required

  on write
    if rental == null
      fail "Choose the rental being returned."
    end
    if not rental.posted
      fail "Only posted rentals can be returned."
    end
  end

  on post
    for line in rental.lines
      EquipmentOut.subtract(equipment: line.equipment, units: 1)
    end
  end
end

# A cash sale of stocked items: stock out at average cost, revenue in.
document CounterSale
  field customer: Customer required
  table lines
    item: Item required
    qty: Quantity required
    price: Money
  end

  on write
    for line in lines
      if line.item != null and line.price == null
        line.price = line.item.salesPrice
      end
    end
  end

  on post
    for line in lines
      stock.issue(line.item, line.qty)
      ledger.post(debit: accounts.undeposited, credit: accounts.sales,
                  amount: round(line.qty * line.price, 2), party: customer,
                  memo: "Counter sale " + number)
    end
  end
end
`;
